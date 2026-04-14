// ============================================================
// Berry Agent SDK — Observe: REST API Server
// ============================================================
// Provides a standalone HTTP server or Express router for observe data.
// Can be embedded into any Express app or run independently.

import { Router } from 'express';
import type { Observer } from './observer.js';

/**
 * Create an Express Router that serves observe API endpoints.
 * Mount it in your app: `app.use('/api/observe', createObserveRouter(observer))`
 */
export function createObserveRouter(observer: Observer): Router {
  const router = Router();
  const { analyzer } = observer;

  // ===== Cost =====
  router.get('/cost', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    res.json(analyzer.costBreakdown(sessionId));
  });

  router.get('/cost/by-model', (_req, res) => {
    res.json(analyzer.costByModel());
  });

  router.get('/cost/trend', (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    res.json(analyzer.costTrend(days));
  });

  // ===== Cache =====
  router.get('/cache', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    res.json(analyzer.cacheEfficiency(sessionId));
  });

  // ===== Tools =====
  router.get('/tools', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    res.json(analyzer.toolStats(sessionId));
  });

  // ===== Guard =====
  router.get('/guard', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    res.json(analyzer.guardStats(sessionId));
  });

  router.get('/guard/decisions', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const llmCallId = req.query.llmCallId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(analyzer.guardDecisionList({ sessionId, llmCallId, limit }));
  });

  // ===== Compaction =====
  router.get('/compaction', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    res.json(analyzer.compactionStats(sessionId));
  });

  router.get('/compaction/list', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(analyzer.compactionList({ sessionId, limit }));
  });

  // ===== Inferences =====
  router.get('/inferences', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(analyzer.inferenceList({ sessionId, agentId, limit }));
  });

  router.get('/inferences/:id', (req, res) => {
    const detail = analyzer.inferenceDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json(detail);
  });

  // ===== Sessions =====
  router.get('/sessions', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(analyzer.recentSessions(limit));
  });

  router.get('/sessions/:id', (req, res) => {
    const summary = analyzer.sessionSummary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Not found' });
    res.json(summary);
  });

  // ===== Agents =====
  router.get('/agents', (_req, res) => {
    res.json(analyzer.agentStats());
  });

  // ===== Cleanup =====
  router.post('/cleanup', (_req, res) => {
    const removed = observer.cleanup();
    res.json({ removed });
  });

  return router;
}
