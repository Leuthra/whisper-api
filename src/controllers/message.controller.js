import logger from '../utils/logger.js';
import whatsappService from '../services/whatsapp.service.js';
const messageController = {
    sendPersonalMessage: async (req, res) => {
        try {
            const { phoneNumber, message } = req.body;

            logger.info(`📨 Send message request received for ${phoneNumber}`);

            // Validation
            if (!phoneNumber || !message) {
                logger.warn('❌ Missing required fields: phoneNumber or message');
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields',
                    message: 'phoneNumber and message are required'
                });
            }

            if (typeof message !== 'string' || message.trim() === '') {
                logger.warn('❌ Invalid message format');
                return res.status(400).json({
                    success: false,
                    error: 'Invalid message format',
                    message: 'Message must be a non-empty string'
                });
            }

            // Check if WhatsApp is connected
            if (!whatsappService.isConnected) {
                logger.warn('❌ WhatsApp not connected');
                return res.status(503).json({
                    success: false,
                    error: 'Service unavailable',
                    message: 'WhatsApp is not connected. Please check connection status.'
                });
            }

            // Send message
            const result = await whatsappService.sendMessage(phoneNumber, message.trim());

            logger.info(`✅ Message sent successfully to ${phoneNumber}`);

            const response = {
                success: true,
                data: {
                    phoneNumber,
                    recipient: result.recipient,
                    message: message.trim(),
                    status: 'sent',
                    timestamp: new Date().toISOString()
                },
                message: result.message
            };

            res.status(200).json(response);

        } catch (error) {
            logger.error('❌ Error in send message controller:', error);

            const response = {
                success: false,
                error: 'Failed to send message',
                message: error.message,
                timestamp: new Date().toISOString()
            };

            res.status(500).json(response);
        }
    },

    sendGroupMessage: async (req, res) => {
        try {
            const { groupId, message } = req.body;

            logger.info(`📨 Send group message request received for ${groupId}`);

            // Validation
            if (!groupId || !message) {
                logger.warn('❌ Missing required fields: groupId or message');
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields',
                    message: 'groupId and message are required'
                });
            }

            if (typeof message !== 'string' || message.trim() === '') {
                logger.warn('❌ Invalid message format');
                return res.status(400).json({
                    success: false,
                    error: 'Invalid message format',
                    message: 'Message must be a non-empty string'
                });
            }

            // Check if WhatsApp is connected
            if (!whatsappService.isConnected) {
                logger.warn('❌ WhatsApp not connected');
                return res.status(503).json({
                    success: false,
                    error: 'Service unavailable',
                    message: 'WhatsApp is not connected. Please check connection status.'
                });
            }

            // Send group message
            const result = await whatsappService.sendGroupMessage(groupId, message.trim());

            logger.info(`✅ Group message sent successfully to ${groupId}`);

            const response = {
                success: true,
                data: {
                    groupId,
                    recipient: result.recipient,
                    message: message.trim(),
                    status: 'sent',
                    timestamp: new Date().toISOString()
                },
                message: result.message
            };

            res.status(200).json(response);

        } catch (error) {
            logger.error('❌ Error in send group message controller:', error);

            const response = {
                success: false,
                error: 'Failed to send group message',
                message: error.message,
                timestamp: new Date().toISOString()
            };

            res.status(500).json(response);
        }
    }
};

export default messageController;
