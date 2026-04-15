// ============================================================
// Berry Agent SDK — Observe: REST API Server
// ============================================================
// Provides a standalone HTTP server or Express router for observe data.
// Can be embedded into any Express app or run independently.

import { Router } from 'express';
import type { Observer } from './observer.js';
import { MetricsCalculator } from './analyzer/metrics.js';

/**
 * Create an Express Router that serves observe API endpoints.
 * Mount it in your app: `app.use('/api/observe', createObserveRouter(observer))`
 */
export function createObserveRouter(observer: Observer): Router {
  const router = Router();
  const { analyzer } = observer;
  const metrics = new MetricsCalculator(analyzer, observer.db);

  // ===== Cost =====
  router.get('/cost', (req, res) => {
    const { sessionId, agentId, turnId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.costBreakdown({ sessionId, agentId, turnId }));
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
    const { sessionId, agentId, turnId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.cacheEfficiency({ sessionId, agentId, turnId }));
  });

  // ===== Tools =====
  router.get('/tools', (req, res) => {
    const { sessionId, agentId, turnId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.toolStats({ sessionId, agentId, turnId }));
  });

  // ===== Guard =====
  router.get('/guard', (req, res) => {
    const { sessionId, agentId, turnId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.guardStats({ sessionId, agentId, turnId }));
  });

  router.get('/guard/decisions', (req, res) => {
    const { sessionId, agentId, turnId, llmCallId, toolName } = req.query as Record<string, string | undefined>;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(analyzer.guardDecisionList({ sessionId, agentId, turnId, llmCallId, toolName, limit }));
  });

  router.get('/guard/by-tool', (req, res) => {
    const { sessionId, agentId, turnId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.guardStatsByTool({ sessionId, agentId, turnId }));
  });

  // ===== Compaction =====
  router.get('/compaction', (req, res) => {
    const { sessionId, agentId } = req.query as Record<string, string | undefined>;
    res.json(analyzer.compactionStats({ sessionId, agentId }));
  });

  router.get('/compaction/list', (req, res) => {
    const { sessionId, agentId } = req.query as Record<string, string | undefined>;
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(analyzer.compactionList({ sessionId, agentId, limit }));
  });

  // ===== Inferences =====
  router.get('/inferences', (req, res) => {
    const { sessionId, agentId, turnId, model } = req.query as Record<string, string | undefined>;
    const limit = parseInt(req.query.limit as string) || 50;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const until = req.query.until ? parseInt(req.query.until as string) : undefined;
    res.json(analyzer.inferenceList({ sessionId, agentId, turnId, model, since, until, limit }));
  });

  router.get('/inferences/:id', (req, res) => {
    const detail = analyzer.inferenceDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json(detail);
  });

  // ===== Turns (NEW) =====
  router.get('/turns', (req, res) => {
    const { sessionId, agentId } = req.query as Record<string, string | undefined>;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(analyzer.turnList({ sessionId, agentId, limit }));
  });

  router.get('/turns/:id', (req, res) => {
    const summary = analyzer.turnSummary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Not found' });
    res.json(summary);
  });

  router.get('/turns/:id/inferences', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(analyzer.inferenceList({ turnId: req.params.id, limit }));
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

  router.get('/agents/:id', (req, res) => {
    const detail = analyzer.agentDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json(detail);
  });

  router.get('/agents/:id/sessions', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(analyzer.recentSessions(limit, req.params.id));
  });

  // ===== Derived Metrics =====
  router.get('/metrics/turn/:turnId', (req, res) => {
    const result = metrics.turnMetrics(req.params.turnId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  });

  router.get('/metrics/session/:sessionId', (req, res) => {
    const result = metrics.sessionMetrics(req.params.sessionId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  });

  router.get('/metrics/agent/:agentId', (req, res) => {
    const result = metrics.agentMetrics(req.params.agentId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  });

  // ===== Cleanup =====
  router.post('/cleanup', (_req, res) => {
    const removed = observer.cleanup();
    res.json({ removed });
  });

  return router;
}
