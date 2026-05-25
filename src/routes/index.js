import express from 'express';
import docsRoutes from './docs.routes.js';
import apiRoutes from './api.routes.js';
const router = express.Router();

// Documentation and API routes
router.use(docsRoutes);
router.use('/api/v1', apiRoutes);

export default router;