import express from 'express';
import cors from 'cors';
import serverless from 'serverless-http';
import campaignRoutes from '../backend/routes/campaignRoutes.js';
import trackingRoutes from '../backend/routes/trackingRoutes.js';
import followupRoutes from '../backend/routes/followupRoutes.js';
import sequenceRoutes from '../backend/routes/sequenceRoutes.js';

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'email-intelligence-backend',
    time: new Date().toISOString(),
  });
});

app.use('/api/campaigns', campaignRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/sequences', sequenceRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { status: 404, message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
});

export const handler = serverless(app);
