import logger from '../utils/logger.js';
import { isJidGroup } from 'baileys';

export const config = {
    enabled: false,
    description: 'Provides admin commands for WhatsApp groups (!kick, !promote, !demote)'
};

function getMentionedJids(message) {
    return message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

async function sendReply(sock, groupId, text, quoted) {
    await sock.sendMessage(groupId, { text }, { quoted });
}

function resolveGroupParticipants(groupMetadata, requestedJids, jidUtils) {
    const resolvedJids = [];
    const unresolvedJids = [];

    for (const requestedJid of requestedJids) {
        const requestedCandidates = jidUtils.uniqueJids([requestedJid]);
        const participant = groupMetadata.participants.find(groupParticipant =>
            jidUtils.hasSameUser(jidUtils.participantJids(groupParticipant), requestedCandidates)
        );

        if (participant?.id) {
            resolvedJids.push(participant.id);
        } else {
            unresolvedJids.push(requestedJid);
        }
    }

    return {
        resolvedJids: jidUtils.uniqueJids(resolvedJids),
        unresolvedJids
    };
}

const adminCommandsPlugin = async ({ props: { enabled = config.enabled, sock, message, jidUtils } }) => {
    if (!enabled) return;

    const textMessage = message?.message?.conversation ||
        message?.message?.extendedTextMessage?.text;

    if (!textMessage || !textMessage.startsWith('!')) return;

    const { key, pushName = 'Anonymous' } = message;
    const { remoteJid: groupId, participant } = key;

    if (!isJidGroup(groupId)) return;

    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const adminParticipants = groupMetadata.participants.filter(p => p.admin);
        const adminJids = adminParticipants.flatMap(jidUtils.participantJids);
        const senderJids = jidUtils.uniqueJids([participant || key.participant || key.remoteJid]);
        const botJids = jidUtils.botJids(sock);
        const botIsAdmin = adminParticipants.some(admin => jidUtils.hasSameUser(jidUtils.participantJids(admin), botJids));

        if (!botIsAdmin) {
            await sendReply(sock, groupId, 'Bot belum admin di group ini, jadi tidak bisa menjalankan command admin.', message);
            logger.warn(`Bot is not admin in ${groupId}; botJids=${botJids.join(', ')} adminJids=${adminJids.join(', ')} command ignored: ${textMessage}`);
            return;
        }

        if (!senderJids.length || !jidUtils.hasSameUser(adminJids, senderJids)) {
            await sendReply(sock, groupId, 'Command ini hanya bisa dipakai oleh admin group.', message);
            logger.warn(`Non-admin ${pushName} tried to use admin command: ${textMessage}; senderJids=${senderJids.join(', ')} adminJids=${adminJids.join(', ')}`);
            return;
        }

        const [command] = textMessage.slice(1).trim().split(/\s+/);

        switch (command.toLowerCase()) {
            case 'kick': {
                const mentionedJids = getMentionedJids(message);
                if (mentionedJids.length === 0) {
                    await sendReply(sock, groupId, 'Usage: !kick @user', message);
                    return;
                }

                const { resolvedJids, unresolvedJids } = resolveGroupParticipants(groupMetadata, mentionedJids, jidUtils);
                if (resolvedJids.length === 0) {
                    await sendReply(sock, groupId, 'Target tidak ditemukan di group.', message);
                    logger.warn(`Kick target not found in ${groupId}: ${mentionedJids.join(', ')}`);
                    return;
                }

                await sock.groupParticipantsUpdate(groupId, resolvedJids, 'remove');
                await sendReply(sock, groupId, `Removed ${resolvedJids.length} participant(s).`, message);
                logger.info(`${pushName} kicked ${resolvedJids.join(', ')} from ${groupId}${unresolvedJids.length ? `; unresolved=${unresolvedJids.join(', ')}` : ''}`);
                break;
            }

            case 'promote': {
                const promoteJids = getMentionedJids(message);
                if (promoteJids.length === 0) {
                    await sendReply(sock, groupId, 'Usage: !promote @user', message);
                    return;
                }

                const { resolvedJids, unresolvedJids } = resolveGroupParticipants(groupMetadata, promoteJids, jidUtils);
                if (resolvedJids.length === 0) {
                    await sendReply(sock, groupId, 'Target tidak ditemukan di group.', message);
                    logger.warn(`Promote target not found in ${groupId}: ${promoteJids.join(', ')}`);
                    return;
                }

                await sock.groupParticipantsUpdate(groupId, resolvedJids, 'promote');
                await sendReply(sock, groupId, `Promoted ${resolvedJids.length} participant(s).`, message);
                logger.info(`${pushName} promoted ${resolvedJids.join(', ')} in ${groupId}${unresolvedJids.length ? `; unresolved=${unresolvedJids.join(', ')}` : ''}`);
                break;
            }

            case 'demote': {
                const demoteJids = getMentionedJids(message);
                if (demoteJids.length === 0) {
                    await sendReply(sock, groupId, 'Usage: !demote @user', message);
                    return;
                }

                const { resolvedJids, unresolvedJids } = resolveGroupParticipants(groupMetadata, demoteJids, jidUtils);
                if (resolvedJids.length === 0) {
                    await sendReply(sock, groupId, 'Target tidak ditemukan di group.', message);
                    logger.warn(`Demote target not found in ${groupId}: ${demoteJids.join(', ')}`);
                    return;
                }

                await sock.groupParticipantsUpdate(groupId, resolvedJids, 'demote');
                await sendReply(sock, groupId, `Demoted ${resolvedJids.length} participant(s).`, message);
                logger.info(`${pushName} demoted ${resolvedJids.join(', ')} in ${groupId}${unresolvedJids.length ? `; unresolved=${unresolvedJids.join(', ')}` : ''}`);
                break;
            }

            default:
                await sendReply(sock, groupId, `Unknown command: ${command}\nAvailable commands: kick, promote, demote`, message);
        }
    } catch (error) {
        logger.error(`Error in admin-commands plugin: ${error.message}`);
        try {
            await sendReply(sock, groupId, `Gagal menjalankan command: ${error.message}`, message);
        } catch (replyError) {
            logger.error(`Failed to send admin command error reply: ${replyError.message}`);
        }
    }
};

export default adminCommandsPlugin;
