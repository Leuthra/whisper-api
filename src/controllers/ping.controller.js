import logger from '../utils/logger.js';
import whatsappService from '../services/whatsapp.service.js';
import packageJson from '../../package.json' with { type: 'json' };
const pingController = {
    ping: async (req, res) => {
        const startTime = Date.now();

        try {
            logger.info('🏓 Ping request received');

            const isServiceAlive = whatsappService.isServiceAlive();
            const responseTime = Date.now() - startTime;

            const response = {
                success: true,
                message: 'pong',
                service: `${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)} API`,
                status: isServiceAlive ? 'alive' : 'dead',
                timestamp: new Date().toISOString(),
                responseTime: `${responseTime}ms`
            };

            logger.info(`✅ Ping response: Service ${response.status}, Response time: ${responseTime}ms`);

            res.status(200).json(response);
        } catch (error) {
            logger.error('❌ Error in ping controller:', error);

            const response = {
                success: false,
                message: 'pong',
                service: `${(s => s[0].toUpperCase() + s.slice(1, s.indexOf('-')))(packageJson.name)} API`,
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            };

            res.status(500).json(response);
        }
    }
};

export default pingController;