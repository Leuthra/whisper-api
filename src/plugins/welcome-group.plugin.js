import logger from '../utils/logger.js';

const WELCOME_DELAY_MS = Number(process.env.WELCOME_GROUP_DELAY_MS || 5 * 60 * 1000);

export const config = {
    enabled: false,
    description: 'Welcomes new members to WhatsApp groups with a scheduled message'
};

const groupParticipants = {};
const groupTimeouts = {};
const groupScheduled = {};

function isConnectionReady(sock) {
    try {
        return sock && sock.user && sock.user.id;
    } catch (error) {
        logger.warn(`Connection check failed: ${error.message}`);
        return false;
    }
}

function clearGroupData(scheduleKey) {
    if (groupTimeouts[scheduleKey]) {
        clearTimeout(groupTimeouts[scheduleKey]);
        delete groupTimeouts[scheduleKey];
    }
    delete groupParticipants[scheduleKey];
    delete groupScheduled[scheduleKey];
}

function getParticipantJid(participant, jidUtils) {
    if (typeof participant === 'string') {
        return jidUtils.normalizeMaybeJid(participant);
    }

    const candidates = [
        participant?.id,
        participant?.jid,
        participant?.lid,
        participant?.phoneNumber
    ].filter(value => typeof value === 'string');

    return jidUtils.uniqueJids(candidates)[0] || null;
}

function getParticipantMention(participant) {
    return participant.id.split('@')[0].split(':')[0];
}

async function scheduleWelcome(groupId, participants, sock, jidUtils, instancePhone) {
    const scheduleKey = `${instancePhone || 'global'}:${groupId}`;

    if (!groupParticipants[scheduleKey]) {
        groupParticipants[scheduleKey] = [];
    }

    groupParticipants[scheduleKey].push(...participants);

    if (!groupScheduled[scheduleKey]) {
        groupScheduled[scheduleKey] = true;
        logger.info(`Scheduled welcome message for ${groupId} in ${Math.round(WELCOME_DELAY_MS / 1000)} seconds (${groupParticipants[scheduleKey].length} participant(s))`);

        groupTimeouts[scheduleKey] = setTimeout(async () => {
            try {
                if (!groupParticipants[scheduleKey] || groupParticipants[scheduleKey].length === 0) {
                    logger.info(`No participants to welcome in ${groupId}; participants may have left`);
                    clearGroupData(scheduleKey);
                    return;
                }

                if (!isConnectionReady(sock)) {
                    logger.warn(`Connection not ready for ${groupId}; skipping welcome message`);
                    clearGroupData(scheduleKey);
                    return;
                }

                let groupMetadata;
                try {
                    groupMetadata = await Promise.race([
                        sock.groupMetadata(groupId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('groupMetadata timeout')), 10000))
                    ]);
                } catch (error) {
                    logger.warn(`Failed to get group metadata for ${groupId}: ${error.message}`);
                    clearGroupData(scheduleKey);
                    return;
                }

                const subjectGroup = groupMetadata.subject;
                const botJids = jidUtils.botJids(sock);
                const adminParticipants = groupMetadata.participants.filter(p => p.admin);
                const isAdmin = adminParticipants.some(admin => jidUtils.hasSameUser(jidUtils.participantJids(admin), botJids));

                if (!isAdmin || groupMetadata.announce) {
                    const reason = !isAdmin ? 'Bot is not admin' : 'Group is announce-only';
                    logger.info(`Skipping welcome message for ${subjectGroup} (${groupId}) - ${reason}; botJids=${botJids.join(', ')}`);
                    clearGroupData(scheduleKey);
                    return;
                }

                const pendingParticipants = groupParticipants[scheduleKey].filter(participant => typeof participant.id === 'string');
                if (pendingParticipants.length === 0) {
                    logger.warn(`No valid participant JIDs to welcome in ${groupId}`);
                    clearGroupData(scheduleKey);
                    return;
                }

                const welcomeMessage = formattedWelcomeText(pendingParticipants, subjectGroup);

                await sock.sendMessage(groupId, {
                    text: welcomeMessage,
                    mentions: pendingParticipants.map(p => p.id),
                });

                logger.info(`Welcomed ${pendingParticipants.length} new member(s) to ${groupId}`);
                clearGroupData(scheduleKey);
            } catch (error) {
                logger.error(`Error sending welcome message to ${groupId}: ${error.message}`);
                clearGroupData(scheduleKey);
            }
        }, WELCOME_DELAY_MS);
    } else {
        logger.info(`Welcome message already scheduled for ${groupId}; pending participants: ${groupParticipants[scheduleKey].length}`);
    }
}

function formattedWelcomeText(participants, subject) {
    const mentions = participants.map(p => `@${getParticipantMention(p)}`).join(' ');
    return `Waspada pendatang baru detected!!
${mentions}

Selamat datang di *${subject}* - Feel free untuk kenalan, share insight, atau sekadar nimbrung obrolan.

Please read the group rules and enjoy your stay.

> "Alone we can do so little, together we can do so much." - Helen Keller`;
}

const welcomeGroupPlugin = async ({ props: { enabled = config.enabled, sock, message, jidUtils, instanceData } }) => {
    if (!enabled) return;

    const groupUpdate = message?.message?.groupUpdate;
    if (!groupUpdate || !groupUpdate.participants) return;

    const { key } = message;
    const { remoteJid: groupId } = key;

    if (groupUpdate.action === 'add') {
        const newParticipants = groupUpdate.participants
            .map(participant => ({
                id: getParticipantJid(participant, jidUtils),
                joinedAt: new Date(),
            }))
            .filter(participant => participant.id);

        logger.info(`Welcome plugin received ${newParticipants.length} new participant(s) for ${groupId}`);
        if (newParticipants.length === 0) {
            logger.warn(`Welcome plugin ignored add update for ${groupId}: no valid participant JIDs`);
            return;
        }

        await scheduleWelcome(groupId, newParticipants, sock, jidUtils, instanceData?.phone);
    } else if (groupUpdate.action === 'remove') {
        const scheduleKey = `${instanceData?.phone || 'global'}:${groupId}`;
        if (groupParticipants[scheduleKey] && groupParticipants[scheduleKey].length > 0) {
            const removedParticipants = groupUpdate.participants
                .map(participant => getParticipantJid(participant, jidUtils))
                .filter(Boolean);

            groupParticipants[scheduleKey] = groupParticipants[scheduleKey].filter(
                participant => !jidUtils.hasSameUser([participant.id], removedParticipants)
            );

            if (groupParticipants[scheduleKey].length === 0) {
                logger.info(`All pending participants left ${groupId}; canceling welcome message`);
                clearGroupData(scheduleKey);
            } else {
                logger.info(`${removedParticipants.length} participant(s) left ${groupId}; ${groupParticipants[scheduleKey].length} still pending welcome`);
            }
        }
    }
};

export default welcomeGroupPlugin;
