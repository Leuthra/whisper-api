import logger from '../utils/logger.js';
const logController = {
    getLogs: async (req, res) => {
        try {
            const { limit = 100, level = 'all' } = req.query;

            logger.info(`📋 Get logs request received - Limit: ${limit}, Level: ${level}`);

            // Validate limit
            const logLimit = Math.min(parseInt(limit) || 100, 1000); // Max 1000 logs

            // Get logs from logger utility
            const logs = logger.getAllLogs(logLimit);

            // Filter by level if specified
            let filteredLogs = logs;
            if (level !== 'all') {
                filteredLogs = logs.filter(log => log.level === level);
            }

            const response = {
                success: true,
                data: {
                    logs: filteredLogs,
                    total: filteredLogs.length,
                    limit: logLimit,
                    level: level,
                    timestamp: new Date().toISOString()
                },
                message: `Retrieved ${filteredLogs.length} log entries`
            };

            logger.info(`📋 Logs response: ${filteredLogs.length} entries returned`);

            res.status(200).json(response);

        } catch (error) {
            logger.error('❌ Error in log controller:', error);

            const response = {
                success: false,
                error: 'Failed to retrieve logs',
                message: error.message,
                timestamp: new Date().toISOString()
            };

            res.status(500).json(response);
        }
    }
};

export default logController;