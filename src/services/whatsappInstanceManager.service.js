import { fileURLToPath } from 'url';
import qrcode from 'qrcode';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import packageJson from '../../package.json' with { type: 'json' };
import PluginManager from '../core/plugin-manager.core.js';
import instanceService from './instanceService.js';
import messageService from './messageService.js';
import webhookService from './webhookService.js';
import webhookHistoryService from './webhookHistoryService.js';
import axios from 'axios';
import instanceLogService from './instanceLogService.js';
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    BufferJSON,
    getContentType,
    jidDecode,
    jidNormalizedUser,
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isLidUser
} from 'baileys';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function toUserJid(value) {
    if (!value) throw new Error('Recipient is required');
    const raw = String(value).trim();
    if (raw.includes('@')) return jidNormalizedUser(raw);

    let formattedNumber = raw.replace(/[^\d]/g, '');
    if (!formattedNumber.startsWith('62')) {
        formattedNumber = formattedNumber.startsWith('0')
            ? `62${formattedNumber.substring(1)}`
            : `62${formattedNumber}`;
    }

    return `${formattedNumber}@s.whatsapp.net`;
}

function toGroupJid(value) {
    if (!value) throw new Error('Group ID is required');
    const raw = String(value).trim();
    return raw.includes('@') ? raw : `${raw}@g.us`;
}

function getBareJidUser(jid) {
    return jid ? String(jid).split('@')[0].split(':')[0] : null;
}

function describeJid(jid) {
    if (!jid) return null;
    const decoded = jidDecode(jid);

    return {
        jid,
        user: decoded?.user || getBareJidUser(jid),
        server: decoded?.server || String(jid).split('@')[1] || null,
        device: decoded?.device ?? null,
        isLid: isLidUser(jid),
        isGroup: isJidGroup(jid),
        isBroadcast: isJidBroadcast(jid),
        isNewsletter: isJidNewsletter(jid)
    };
}

function getMessageJids(message, sock, instancePhone) {
    const remoteJid = message?.key?.remoteJid || null;
    const selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : toUserJid(instancePhone);
    const participantJid = message?.key?.participant || null;
    const senderJid = message?.key?.fromMe ? selfJid : (participantJid || remoteJid);

    return {
        chatJid: remoteJid,
        senderJid,
        participantJid,
        selfJid,
        chat: describeJid(remoteJid),
        sender: describeJid(senderJid),
        participant: describeJid(participantJid),
        self: describeJid(selfJid)
    };
}

class WhatsAppInstance {
    constructor(instanceData) {
        this.instanceData = instanceData;
        this.sock = null;
        this.isConnected = false;
        this.connectionStatus = 'disconnected';
        this.qrCode = null;
        this.authDir = path.join(__dirname, `../../auth/${instanceData.phone}`);
        this.pluginManager = new PluginManager(instanceData);
        this.groupMetadataCache = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.isManualRestart = false; // Flag to prevent auto-reconnect during manual restart
    }

    async initialize() {
        try {
            logger.info(`🔄 Initializing WhatsApp instance for ${this.instanceData.phone}...`);

            // Update instance status to connecting
            await instanceService.updateStatus(this.instanceData.id, 'connecting');

            // Create auth directory if it doesn't exist
            if (!fs.existsSync(this.authDir)) {
                fs.mkdirSync(this.authDir, { recursive: true });
            }

            // Initialize plugin manager
            await this.pluginManager.loadPlugins();

            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            logger.info(`📱 Using WA version ${version.join('.')}, isLatest: ${isLatest} for ${this.instanceData.phone}`);

            this.sock = makeWASocket({
                version,
                auth: state,
                logger: {
                    level: 'error',
                    trace: () => {},
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: (data, msg) => {
                        // Only log meaningful errors, ignore debug objects
                        if (msg && typeof msg === 'string') {
                            logger.error(`[Baileys] ${msg}`);
                        } else if (data && data.err && data.err instanceof Error) {
                            logger.error(`[Baileys] ${data.err.message}`);
                        }
                    },
                    fatal: (msg) => logger.error(`[Baileys Fatal] ${msg}`),
                    child: () => ({
                        level: 'error',
                        trace: () => {},
                        debug: () => {},
                        info: () => {},
                        warn: () => {},
                        error: (data, msg) => {
                            if (msg && typeof msg === 'string') {
                                logger.error(`[Baileys] ${msg}`);
                            } else if (data && data.err && data.err instanceof Error) {
                                logger.error(`[Baileys] ${data.err.message}`);
                            }
                        },
                        fatal: (msg) => logger.error(`[Baileys Fatal] ${msg}`)
                    })
                },
                cachedGroupMetadata: async (jid) => {
                    if (this.groupMetadataCache.has(jid)) {
                        return this.groupMetadataCache.get(jid);
                    }

                    try {
                        const metadata = await this.sock.groupMetadata(jid);
                        this.groupMetadataCache.set(jid, metadata);
                        return metadata;
                    } catch (error) {
                        logger.error(`Error getting group metadata of ${jid} for ${this.instanceData.phone}: ${error.message}`);
                        return null;
                    }
                }
            });

            this.setupEventHandlers(saveCreds);

            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'info',
                message: `WhatsApp instance initialized. WA version ${version.join('.')} is latest? ${isLatest}`
            });

        } catch (error) {
            logger.error(`❌ Error initializing WhatsApp instance ${this.instanceData.phone}:`, error);
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'error',
                message: `Error initializing WhatsApp instance: ${error.message}`
            });
            this.connectionStatus = 'error';
            await instanceService.updateStatus(this.instanceData.id, 'error');
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCode = qr;
                logger.info(`📱 QR Code generated for ${this.instanceData.phone}. Scan to connect.`);
                this.connectionStatus = 'qr_ready';
                await instanceService.updateStatus(this.instanceData.id, 'qr_ready');
                
                const qrCodeImage = await qrcode.toDataURL(qr);
                // Trigger webhook for QR code generation
                await this.triggerWebhooks('connection.update', {
                    status: 'qr_ready',
                    qrCode: qr,
                    qrCodeImage: qrCodeImage, 
                    instance: this.instanceData,
                    timestamp: new Date().toISOString(),
                    message: 'QR Code generated. Scan to connect.'
                });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const disconnectReason = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message;
                
                logger.info(`🔌 Connection closed for ${this.instanceData.phone}. Reason: ${disconnectReason}, Error: ${errorMessage}`);

                // Check if this is a real manual restart or just a stream error
                // Stream errors (code 515) during QR scanning should not be treated as manual restart
                const isStreamError = disconnectReason === 515;
                const wasManualRestart = this.isManualRestart && !isStreamError;
                
                // Reset manual restart flag after connection close
                this.isManualRestart = false;

                // Don't auto-reconnect if this was a manual restart or if we're logged out
                if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts && !wasManualRestart) {
                    this.reconnectAttempts++;
                    logger.info(`🔄 Connection lost for ${this.instanceData.phone}, reconnecting... (attempt ${this.reconnectAttempts})`);
                    this.connectionStatus = 'reconnecting';
                    this.isConnected = false;
                    await instanceService.updateStatus(this.instanceData.id, 'reconnecting');
                    
                    // Trigger webhook for reconnecting state
                    await this.triggerWebhooks('connection.update', {
                        status: 'reconnecting',
                        instance: this.instanceData,
                        timestamp: new Date().toISOString(),
                        reconnectAttempt: this.reconnectAttempts,
                        maxReconnectAttempts: this.maxReconnectAttempts,
                        message: `Connection lost. Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
                        disconnectReason: disconnectReason,
                        errorMessage: errorMessage
                    });
                    
                    setTimeout(() => this.initialize(), 5000);
                } else {
                    if (wasManualRestart) {
                        logger.info(`🔄 Connection closed for ${this.instanceData.phone} due to manual restart - not cleaning up`);
                        // Don't clean up if it was a manual restart, just update status
                        this.connectionStatus = 'disconnected';
                        this.isConnected = false;
                        await instanceService.updateStatus(this.instanceData.id, 'inactive');
                    } else {
                        logger.info(`🔓 Connection closed for ${this.instanceData.phone}, logged out or max reconnect attempts reached`);
                        
                        // Use the singleton manager to handle logout and cleanup while keeping database records
                        try {
                            await instanceManager.deleteInstance(this.instanceData.phone, true, { skipLogout: true }); // keepDatabaseRecord = true
                            logger.info(`🗑️ Instance ${this.instanceData.phone} cleaned up, database record preserved`);
                        } catch (cleanupError) {
                            logger.error(`Error during logout cleanup for ${this.instanceData.phone}: ${cleanupError.message}`);
                            // Fallback to manual cleanup
                            await instanceService.updateStatus(this.instanceData.id, 'inactive');
                        }
                        
                        this.connectionStatus = 'logged_out';
                        this.isConnected = false;
                    }
                    
                    // Trigger webhook for connection close
                    await this.triggerWebhooks('connection.update', {
                        status: wasManualRestart ? 'manual_restart' : 'logged_out',
                        instance: this.instanceData,
                        timestamp: new Date().toISOString(),
                        message: wasManualRestart ? 'Connection closed due to manual restart' : 'Logged out or max reconnect attempts reached - auth folder cleaned, restart instance for new QR',
                        disconnectReason: disconnectReason,
                        errorMessage: errorMessage,
                        wasManualRestart: wasManualRestart,
                        authFolderCleaned: !wasManualRestart
                    });
                }
            } else if (connection === 'open') {
                logger.info(`✅ WhatsApp connection established for ${this.instanceData.phone}`);
                this.connectionStatus = 'connected';
                this.isConnected = true;
                this.qrCode = null;
                this.reconnectAttempts = 0;
                await instanceService.updateStatus(this.instanceData.id, 'active');
                
                // Trigger webhook for successful connection
                await this.triggerWebhooks('connection.update', {
                    status: 'connected',
                    instance: this.instanceData,
                    timestamp: new Date().toISOString(),
                    message: 'WhatsApp connection established successfully',
                    previousReconnectAttempts: this.reconnectAttempts
                });
            } else if (connection === 'connecting') {
                logger.info(`🔄 Connecting to WhatsApp for ${this.instanceData.phone}...`);
                this.connectionStatus = 'connecting';
                await instanceService.updateStatus(this.instanceData.id, 'connecting');
                
                // Trigger webhook for connecting state
                await this.triggerWebhooks('connection.update', {
                    status: 'connecting',
                    instance: this.instanceData,
                    timestamp: new Date().toISOString(),
                    message: 'Attempting to connect to WhatsApp...'
                });
            }

            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'info',
                message: `Connection status changed: ${connection}`
            });
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.handleMessagesUpsert.bind(this));
        this.sock.ev.on('group-participants.update', this.handleGroupUpdate.bind(this));
        
        // Add error handling for Baileys internal errors (like MAC errors)
        this.sock.ev.on('CB:call', (callUpdate) => {
            // Handle call updates if needed
        });
        
        // Handle stream errors and message decryption failures
        this.sock.ws.on('error', (error) => {
            logger.warn(`WebSocket error for ${this.instanceData.phone}: ${error.message}`);
        });
        
    }

    async handleGroupUpdate(update) {
        const { id, participants, action } = update;
        const message = { message: { groupUpdate: { participants, action } }, key: { remoteJid: id } };

        try {
            logger.info(`👥 Group participant update for ${this.instanceData.phone} in ${id}: ${action}`);
            await this.pluginManager.executePlugins(this.sock, message);
        } catch (error) {
            logger.error(`Error processing group participant update for ${this.instanceData.phone}: ${error.message}`);
        }
    }

    async handleMessagesUpsert(messageUpdate) {
        const { messages, type } = messageUpdate;

        if (type !== 'notify') return;

        for (const message of messages) {
            // Skip messages from self
            if (message.key.fromMe) continue;

            try {
                logger.info(`📨 Processing message from ${message.pushName || 'Unknown'} for instance ${this.instanceData.phone}`);

                // Store message in database
                await this.storeMessage(message);

                // Execute plugins
                await this.pluginManager.executePlugins(this.sock, message);

                // Trigger webhooks
                await this.triggerWebhooks('message.received', { message, instance: this.instanceData });

            } catch (error) {
                logger.error(`Error processing message for ${this.instanceData.phone}: ${error.message}`);
            }
        }
    }

    /**
     * Safely serialize an object to JSON-compatible format
     * Converts non-serializable objects like Uint8Array, functions, etc.
     */
    safeSerialize(obj) {
        try {
            return JSON.parse(JSON.stringify(obj, (key, value) => {
                const baileysValue = BufferJSON.replacer(key, value);
                if (baileysValue !== value) return baileysValue;

                // Handle Uint8Array
                if (value instanceof Uint8Array) {
                    return {
                        __type: 'Uint8Array',
                        data: Array.from(value)
                    };
                }
                
                // Handle functions
                if (typeof value === 'function') {
                    return {
                        __type: 'Function',
                        name: value.name || 'anonymous'
                    };
                }
                
                // Handle Buffer objects
                if (Buffer.isBuffer(value)) {
                    return {
                        __type: 'Buffer',
                        data: value.toString('base64')
                    };
                }
                
                // Handle circular references and other complex objects
                if (value && typeof value === 'object') {
                    // Check if it's a plain object or array
                    if (Object.prototype.toString.call(value) === '[object Object]' || Array.isArray(value)) {
                        return value;
                    }
                    // For other object types, convert to string representation
                    return {
                        __type: 'ComplexObject',
                        toString: value.toString()
                    };
                }
                
                return value;
            }));
        } catch (error) {
            logger.warn(`Failed to serialize object, using fallback: ${error.message}`);
            // Fallback: return a safe representation
            return {
                __serialization_error: true,
                error: error.message,
                type: typeof obj,
                toString: obj?.toString?.() || 'Unable to convert to string'
            };
        }
    }

    /**
     * Extract timestamp from Baileys Long object or number
     * @param {*} timestamp - The timestamp from Baileys (can be Long object or number)
     * @returns {number} - Unix timestamp in seconds
     */
    extractTimestamp(timestamp) {
        if (typeof timestamp === 'number') {
            return timestamp;
        }
        
        // Handle Long object from Baileys
        if (timestamp && typeof timestamp === 'object' && ('low' in timestamp || 'high' in timestamp)) {
            // Convert Long object to number
            if (timestamp.toNumber && typeof timestamp.toNumber === 'function') {
                return timestamp.toNumber();
            }
            
            // Manual conversion for Long-like objects
            const low = timestamp.low || 0;
            const high = timestamp.high || 0;
            return high * 0x100000000 + (low >>> 0);
        }
        
        // Fallback to current timestamp if we can't parse it
        logger.warn(`Unable to parse timestamp: ${JSON.stringify(timestamp)}, using current time`);
        return Math.floor(Date.now() / 1000);
    }

    async storeMessage(message) {
        try {
            // Safely serialize the raw message to avoid Prisma serialization errors
            const safeRawMessage = this.safeSerialize(message);
            const jids = getMessageJids(message, this.sock, this.instanceData.phone);
            const messageType = getContentType(message.message || {}) || 'unknown';
            
            const messageData = {
                instanceId: this.instanceData.id,
                direction: 'incoming',
                from: jids.senderJid,
                to: jids.selfJid,
                type: messageType,
                message: {
                    content: message.message?.conversation || 
                             message.message?.extendedTextMessage?.text ||
                             message.message?.imageMessage?.caption ||
                             'Media message',
                    pushName: message.pushName,
                    messageId: message.key.id,
                    timestamp: this.extractTimestamp(message.messageTimestamp),
                    chatJid: jids.chatJid,
                    senderJid: jids.senderJid,
                    participantJid: jids.participantJid,
                    selfJid: jids.selfJid,
                    jidInfo: {
                        chat: jids.chat,
                        sender: jids.sender,
                        participant: jids.participant,
                        self: jids.self
                    },
                    raw: safeRawMessage
                },
                status: 'received',
                sentAt: new Date(this.extractTimestamp(message.messageTimestamp) * 1000)
            };

            await messageService.create(messageData);
        } catch (error) {
            logger.error(`Error storing message for ${this.instanceData.phone}: ${error.message}`);
        }
    }

    async triggerWebhooks(event, data) {
        try {
            const webhooks = await webhookService.getEnabledWebhooks(this.instanceData.id, event);
            
            for (const webhook of webhooks) {
                const startTime = Date.now();
                const payload = {
                    event,
                    data,
                    timestamp: new Date().toISOString(),
                    instanceId: this.instanceData.id
                };

                let historyData = {
                    instanceId: this.instanceData.id,
                    webhookId: webhook.id,
                    event: event,
                    payload: payload,
                    status: 'pending',
                    retryCount: 0
                };

                try {
                    const response = await axios.post(webhook.url, payload, {
                        timeout: 5000,
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': `${packageJson.name}/${packageJson.version}`
                        }
                    });

                    const responseTime = Date.now() - startTime;
                    
                    // Update history with success data
                    historyData = {
                        ...historyData,
                        status: 'success',
                        httpStatusCode: response.status,
                        responseTime: responseTime,
                        response: {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                            data: response.data
                        },
                        completedAt: new Date()
                    };

                    logger.info(`📡 Webhook ${webhook.id} triggered successfully for ${event} (${responseTime}ms)`);
                    
                } catch (error) {
                    const responseTime = Date.now() - startTime;
                    let status = 'failed';
                    let httpStatusCode = null;
                    let response = null;
                    
                    if (error.code === 'ECONNABORTED') {
                        status = 'timeout';
                    } else if (error.response) {
                        httpStatusCode = error.response.status;
                        response = {
                            status: error.response.status,
                            statusText: error.response.statusText,
                            headers: error.response.headers,
                            data: error.response.data
                        };
                    }

                    // Update history with failure data
                    historyData = {
                        ...historyData,
                        status: status,
                        httpStatusCode: httpStatusCode,
                        responseTime: responseTime,
                        response: response,
                        errorMessage: error.message,
                        completedAt: new Date()
                    };

                    logger.error(`Failed to trigger webhook ${webhook.id} for ${event}: ${error.message} (${responseTime}ms)`);
                }

                // Save webhook history record
                try {
                    await webhookHistoryService.create(historyData);
                } catch (historyError) {
                    logger.error(`Failed to save webhook history for ${webhook.id}: ${historyError.message}`);
                }
            }
        } catch (error) {
            logger.error(`Error triggering webhooks for ${this.instanceData.phone}: ${error.message}`);
        }
    }

    async sendMessage(phoneNumber, messageText) {
        try {
            if (!this.isConnected) {
                throw new Error(`WhatsApp instance ${this.instanceData.phone} not connected`);
            }

            const jid = toUserJid(phoneNumber);
            const selfJid = this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : toUserJid(this.instanceData.phone);
            const recipientInfo = describeJid(jid);

            logger.info(`📤 Sending message from ${this.instanceData.phone} to ${jid}: ${messageText}`);

            // Add watermark
            const finalMessage = `${messageText}\n\n> Sent via ${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)}\n> @${packageJson.author}/${packageJson.name}.git`;

            const result = await this.sock.sendMessage(jid, { text: finalMessage });

            // Store sent message in database
            const messageData = {
                instanceId: this.instanceData.id,
                direction: 'outgoing',
                from: selfJid,
                to: jid,
                type: 'text',
                message: {
                    content: messageText,
                    messageId: result.key.id,
                    chatJid: jid,
                    senderJid: selfJid,
                    recipientJid: jid,
                    jidInfo: {
                        chat: recipientInfo,
                        sender: describeJid(selfJid),
                        recipient: recipientInfo
                    }
                },
                status: 'sent',
                sentAt: new Date()
            };

            const storedMessage = await messageService.create(messageData);

            // Trigger webhook
            await this.triggerWebhooks('message.sent', { 
                message: storedMessage, 
                instance: this.instanceData,
                recipient: jid,
                jidInfo: recipientInfo
            });

            logger.info(`✅ Message sent successfully from ${this.instanceData.phone} to ${phoneNumber}`);
            
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'info',
                message: `Message sent: ${messageText}`
            });
            
            return { success: true, message: 'Message sent successfully', messageId: result.key.id, recipient: jid, jidInfo: recipientInfo };

        } catch (error) {
            logger.error(`❌ Error sending message from ${this.instanceData.phone}:`, error);
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'error',
                message: `Error sending message: ${error.message}`
            });
            throw error;
        }
    }

    async sendGroupMessage(groupId, messageText) {
        try {
            if (!this.isConnected) {
                throw new Error(`WhatsApp instance ${this.instanceData.phone} not connected`);
            }

            const jid = toGroupJid(groupId);
            const selfJid = this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : toUserJid(this.instanceData.phone);
            const groupInfo = describeJid(jid);

            logger.info(`📤 Sending group message from ${this.instanceData.phone} to ${jid}: ${messageText}`);

            // Ensure we have group metadata and participants before sending
            try {
                await this.sock.groupMetadata(jid);
            } catch (metaError) {
                logger.warn(`Could not fetch group metadata for ${jid}: ${metaError.message}`);
            }

            // Add watermark  
            const finalMessage = `${messageText}\n\n> Sent via ${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)}\n> @${packageJson.author}/${packageJson.name}.git`;

            // Send with additional options to handle encryption properly
            const result = await this.sock.sendMessage(jid, { text: finalMessage }, { 
                ephemeralExpiration: 0,
                messageId: undefined // Let Baileys generate the message ID
            });

            // Store sent message in database
            const messageData = {
                instanceId: this.instanceData.id,
                direction: 'outgoing',
                from: selfJid,
                to: jid,
                type: 'text',
                message: {
                    content: messageText,
                    messageId: result.key.id,
                    isGroup: true,
                    chatJid: jid,
                    senderJid: selfJid,
                    jidInfo: {
                        chat: groupInfo,
                        sender: describeJid(selfJid)
                    }
                },
                status: 'sent',
                sentAt: new Date()
            };

            const storedMessage = await messageService.create(messageData);

            // Trigger webhook
            await this.triggerWebhooks('message.sent', { 
                message: storedMessage, 
                instance: this.instanceData,
                recipient: jid,
                isGroup: true,
                jidInfo: groupInfo
            });

            logger.info(`✅ Group message sent successfully from ${this.instanceData.phone} to ${groupId}`);
            
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'info',
                message: `Group message sent to ${groupId}: ${messageText}`
            });
            
            return { success: true, message: 'Group message sent successfully', messageId: result.key.id, recipient: jid, jidInfo: groupInfo };

        } catch (error) {
            logger.error(`❌ Error sending group message from ${this.instanceData.phone}:`, error);
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'error',
                message: `Error sending group message: ${error.message}`
            });
            throw error;
        }
    }

    async sendMediaMessage(phoneNumber, mediaData) {
        try {
            if (!this.isConnected) {
                throw new Error(`WhatsApp instance ${this.instanceData.phone} not connected`);
            }

            const jid = toUserJid(phoneNumber);
            const selfJid = this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : toUserJid(this.instanceData.phone);
            const recipientInfo = describeJid(jid);
            const { type, url, caption, filename } = mediaData;

            logger.info(`📤 Sending ${type} media from ${this.instanceData.phone} to ${jid}`);

            // Prepare media message object based on type
            let messageContent = {};
            
            switch (type.toLowerCase()) {
                case 'image':
                    messageContent = {
                        image: { url },
                        caption: caption ? `${caption}\n\n> Sent via ${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)}\n> @${packageJson.author}/${packageJson.name}.git` : undefined
                    };
                    break;
                case 'video':
                    messageContent = {
                        video: { url },
                        caption: caption ? `${caption}\n\n> Sent via ${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)}\n> @${packageJson.author}/${packageJson.name}.git` : undefined
                    };
                    break;
                case 'audio':
                    messageContent = {
                        audio: { url },
                        mimetype: 'audio/mp4'
                    };
                    break;
                case 'document':
                    messageContent = {
                        document: { url },
                        fileName: filename || 'document',
                        caption: caption ? `${caption}\n\n> Sent via ${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)}\n> @${packageJson.author}/${packageJson.name}.git` : undefined
                    };
                    break;
                default:
                    throw new Error(`Unsupported media type: ${type}. Supported types: image, video, audio, document`);
            }

            const result = await this.sock.sendMessage(jid, messageContent);

            // Store sent message in database
            const messageData = {
                instanceId: this.instanceData.id,
                direction: 'outgoing',
                from: selfJid,
                to: jid,
                type: type.toLowerCase(),
                message: {
                    content: caption || `${type} media`,
                    messageId: result.key.id,
                    chatJid: jid,
                    senderJid: selfJid,
                    recipientJid: jid,
                    mediaType: type.toLowerCase(),
                    mediaUrl: url,
                    filename: filename,
                    jidInfo: {
                        chat: recipientInfo,
                        sender: describeJid(selfJid),
                        recipient: recipientInfo
                    }
                },
                status: 'sent',
                sentAt: new Date()
            };

            const storedMessage = await messageService.create(messageData);

            // Trigger webhook
            await this.triggerWebhooks('message.sent', { 
                message: storedMessage, 
                instance: this.instanceData,
                recipient: jid,
                mediaType: type.toLowerCase(),
                jidInfo: recipientInfo
            });

            logger.info(`✅ ${type} media sent successfully from ${this.instanceData.phone} to ${phoneNumber}`);
            
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'info',
                message: `${type} media sent${caption ? " with caption: " + caption : ''}`
            });
            
            return { success: true, message: `${type} media sent successfully`, messageId: result.key.id, recipient: jid, jidInfo: recipientInfo };

        } catch (error) {
            logger.error(`❌ Error sending media message from ${this.instanceData.phone}:`, error);
            await instanceLogService.create({
                instanceId: this.instanceData.id,
                level: 'error',
                message: `Error sending media message: ${error.message}`
            });
            throw error;
        }
    }

    async close() {
        // Close connection without logging out (for restart)
        if (this.sock && this.sock.ws) {
            try {
                this.sock.ws.close();
                logger.info(`🔌 Connection closed for ${this.instanceData.phone}`);
            } catch (error) {
                logger.error(`Error closing connection for ${this.instanceData.phone}:`, error);
            }
        }
        
        this.isConnected = false;
        this.connectionStatus = 'disconnected';
        // Don't update status to inactive for close (only for logout)
    }

    async disconnect(options = {}) {
        const { skipLogout = false } = options;
        if (this.sock && !skipLogout) {
            try {
                await this.sock.logout();
                logger.info(`🔓 Instance ${this.instanceData.phone} logged out`);
            } catch (error) {
                const statusCode = error?.output?.statusCode;
                if (statusCode === 428 || error?.message === 'Connection Closed') {
                    logger.warn(`Logout skipped for ${this.instanceData.phone}: socket already closed`);
                } else {
                    logger.error(`Error logging out instance ${this.instanceData.phone}:`, error);
                }
            }
        } else if (skipLogout) {
            logger.info(`Skipping logout for ${this.instanceData.phone}: socket already closed`);
        }
        
        this.isConnected = false;
        this.connectionStatus = 'disconnected';
        await instanceService.updateStatus(this.instanceData.id, 'inactive');
    }

    async getStatus() {
        const qrCodeImage = this.qrCode ? await qrcode.toDataURL(this.qrCode) : null;
        return {
            instanceId: this.instanceData.id,
            phone: this.instanceData.phone,
            name: this.instanceData.name,
            alias: this.instanceData.alias,
            isConnected: this.isConnected,
            connectionStatus: this.connectionStatus,
            qrCode: this.qrCode,
            qrCodeImage: qrCodeImage,
            reconnectAttempts: this.reconnectAttempts,
            timestamp: new Date().toISOString()
        };
    }
}

class WhatsAppInstanceManager {
    constructor() {
        this.instances = new Map(); // phone -> WhatsAppInstance
        this.initialized = false;
    }

    async initialize() {
        try {
            logger.info('🔄 Initializing WhatsApp Instance Manager...');
            
            // Load existing instances from database
            const existingInstances = await instanceService.findAll();
            
            for (const instanceData of existingInstances) {
                const instance = new WhatsAppInstance(instanceData);
                this.instances.set(instanceData.phone, instance);
                
                // Initialize instance if it was active before
                if (instanceData.status === 'active' || instanceData.status === 'connecting') {
                    await instance.initialize();
                }
            }

            this.initialized = true;
            logger.info(`✅ WhatsApp Instance Manager initialized with ${existingInstances.length} instances`);
            
        } catch (error) {
            logger.error('❌ Error initializing WhatsApp Instance Manager:', error);
            throw error;
        }
    }

    async createInstance(instanceData) {
        try {
            // Create instance in database
            const dbInstance = await instanceService.create(instanceData);
            
            // Create and initialize WhatsApp instance
            const instance = new WhatsAppInstance(dbInstance);
            this.instances.set(dbInstance.phone, instance);
            
            // Initialize the instance
            await instance.initialize();
            
            logger.info(`✅ WhatsApp instance created for ${dbInstance.phone}`);
            return dbInstance;
            
        } catch (error) {
            logger.error(`❌ Error creating WhatsApp instance:`, error);
            throw error;
        }
    }

    async deleteInstance(phone, keepDatabaseRecord = false, options = {}) {
        try {
            const instance = this.instances.get(phone);
            if (instance) {
                await instance.disconnect(options);
                this.instances.delete(phone);
            }

            // Delete from database only if not keeping records
            if (!keepDatabaseRecord) {
                const dbInstance = await instanceService.findByPhone(phone);
                if (dbInstance) {
                    await instanceService.delete(dbInstance.id);
                }
            }

            // Remove auth directory
            const authDir = path.join(__dirname, `../../auth/${phone}`);
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
            }

            const message = keepDatabaseRecord 
                ? 'Instance logged out and cleaned up successfully. Restart to get new QR code.'
                : 'Instance deleted successfully';
            
            logger.info(`✅ WhatsApp instance ${keepDatabaseRecord ? 'cleaned up' : 'deleted'} for ${phone}`);
            return { success: true, message };
            
        } catch (error) {
            logger.error(`❌ Error ${keepDatabaseRecord ? 'cleaning up' : 'deleting'} WhatsApp instance ${phone}:`, error);
            throw error;
        }
    }

    getInstance(phone) {
        return this.instances.get(phone);
    }

    async getAllInstances() {
        const statuses = await Promise.all(
            Array.from(this.instances.values()).map(instance => instance.getStatus())
        );
        return statuses;
    }

    async getInstanceByPhone(phone) {
        const instance = this.instances.get(phone);
        if (instance) {
            const statuses = await instance.getStatus();
            return statuses;
        }

        // Try to get from database
        const dbInstance = await instanceService.findByPhone(phone);
        return dbInstance ? {
            instanceId: dbInstance.id,
            phone: dbInstance.phone,
            name: dbInstance.name,
            alias: dbInstance.alias,
            isConnected: false,
            connectionStatus: 'disconnected',
            qrCode: null,
            timestamp: new Date().toISOString()
        } : null;
    }

    async sendMessage(phone, recipientNumber, message) {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`WhatsApp instance ${phone} not found`);
        }
        return await instance.sendMessage(recipientNumber, message);
    }

    async sendGroupMessage(phone, groupId, message) {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`WhatsApp instance ${phone} not found`);
        }
        return await instance.sendGroupMessage(groupId, message);
    }

    async sendMediaMessage(phone, recipientNumber, mediaData) {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`WhatsApp instance ${phone} not found`);
        }
        return await instance.sendMediaMessage(recipientNumber, mediaData);
    }

    async restartInstance(phone) {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`WhatsApp instance ${phone} not found`);
        }

        // Set manual restart flag to prevent auto-reconnection
        instance.isManualRestart = true;
        
        // Close connection without logging out (to preserve auth)
        await instance.close();
        
        // Wait a moment for clean disconnection
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Initialize the instance again
        await instance.initialize();
        
        return { success: true, message: 'Instance restarted successfully' };
    }

    async getManagerStatus() {
        const statuses = await this.getAllInstances();
        return {
            initialized: this.initialized,
            totalInstances: this.instances.size,
            connectedInstances: Array.from(this.instances.values()).filter(i => i.isConnected).length,
            instances: statuses
        };
    }
}

// Create singleton instance
const instanceManager = new WhatsAppInstanceManager();

export default instanceManager;
