import logger from '../utils/logger.js';
import packageJson from '../../package.json' with { type: 'json' };

export const config = {
    enabled: false,
    description: 'Automatically kicks users who spam mention groups in specified WhatsApp groups',
    groupJids: (process.env.ANTI_MENTION_GROUP_JIDS || '')
        .split(',')
        .map(jid => jid.trim())
        .filter(Boolean)
};

const antiMentionPlugin = async ({ props: { enabled = config.enabled, sock, message, groupJids = config.groupJids, jidUtils } }) => {
    if (!enabled) return;

    const groupMention = message?.message?.groupStatusMentionMessage;

    if (!groupMention) return;

    const { key, pushName = 'Anonymous' } = message;
    const { remoteJid: groupId, participant } = key;

    if (!participant || !groupJids.some(jid => jidUtils.areJidsSameUser(jid, groupId))) return;

    logger.warn(`Group mentioned by ${pushName} [${participant}] in ${groupId}`);
    logger.info('Preparing to kick mentioned spammer');

    const mentionName = participant.split('@')[0].split(':')[0];
    const textContent = `Group mention spam detected from @${mentionName}.\n\n> Sent via ${packageJson.name}\n> @${packageJson.author}/${packageJson.name}.git`;

    await sock.sendMessage(groupId, {
        text: textContent,
        mentions: [participant],
    }, { quoted: message });

    await sock.sendMessage(groupId, { delete: key });

    setTimeout(async () => {
        await sock.groupParticipantsUpdate(groupId, [participant], 'remove');
        logger.info(`${pushName} [${participant}] has been kicked from ${groupId}`);
    }, 10_000);
};

export default antiMentionPlugin;
