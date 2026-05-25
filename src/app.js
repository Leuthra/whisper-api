import { fileURLToPath } from 'url';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import logger from './utils/logger.js';
import whatsappService from './services/whatsapp.service.js';
import instanceManager from './services/whatsappInstanceManager.service.js';
import modeConfig from './config/mode.config.js';
import routes from './routes/index.js';
import 'dotenv/config';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('👋 Shutting down gracefully...');
    process.exit(0);
});

// Plugin management API 
process.on('SIGUSR1', async () => {
    logger.info('🔄 Reloading plugins...');
    await whatsappService.reloadPlugins();
});

app.use(express.static(path.join(__dirname, '../public')));

// Middleware
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
                "img-src": ["'self'", "data:", "https:", "http:"],
            },
        },
    })
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Custom morgan format with winston
app.use(morgan('combined', {
    stream: {
        write: (message) => {
            logger.info(message.trim());
        }
    }
}));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Mount all routes (docs and API)
app.use(routes);

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// 404 handler
app.use((req, res) => {
    logger.warn(`404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

// Initialize services based on configured mode
const initializeServices = async () => {
    try {
        logger.info(`🔧 Starting in ${modeConfig.getModeDescription()}`);

        // Initialize single-instance service (legacy) if enabled
        if (modeConfig.isSingleModeEnabled()) {
            logger.info('🔄 Initializing single-instance service (legacy)...');
            await whatsappService.initialize();
            logger.info('✅ Single-instance service initialized');
        } else {
            logger.info('⏭️  Single-instance service disabled');
        }

        // Initialize multi-instance manager if enabled
        if (modeConfig.isMultiModeEnabled()) {
            logger.info('🔄 Initializing multi-instance manager...');
            await instanceManager.initialize();
            logger.info('✅ Multi-instance manager initialized');
        } else {
            logger.info('⏭️  Multi-instance manager disabled');
        }

        logger.info('✅ WhatsApp services initialization completed');
    } catch (error) {
        logger.error('❌ Error initializing WhatsApp services:', error);
    }
};

// Start server
app.listen(PORT, async () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📱 WhatsApp API server started`);

    // Initialize services after server starts
    await initializeServices();
});

export default app;