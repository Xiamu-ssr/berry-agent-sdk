import { z } from 'zod';
import { WORKLIST_STATUS_VALUES } from './types.js';

export const zTeammateRecord = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string(),
  tier: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.number(),
}).strict();

export const zTeamState = z.object({
  name: z.string().min(1),
  project: z.string().min(1),
  leaderId: z.string().min(1),
  teammates: z.array(zTeammateRecord),
  createdAt: z.number(),
}).strict();

export const zWorklistTaskStatus = z.enum(
  WORKLIST_STATUS_VALUES as readonly ['unclaimed', 'claimed', 'in_progress', 'done', 'failed'],
);

const zWorklistActor = z.string().min(1);

export const zWorklistTask = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: zWorklistTaskStatus,
  assignee: zWorklistActor.optional(),
  createdBy: zWorklistActor,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  failureReason: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

export const zWorklistState = z.object({
  tasks: z.array(zWorklistTask),
  nextId: z.number().int().nonnegative(),
  updatedAt: z.number(),
}).strict();

export const zTeamMessage = z.object({
  id: z.string().min(1),
  ts: z.number(),
  from: z.string().min(1),
  to: z.string().min(1),
  content: z.string(),
  replyTo: z.string().optional(),
}).strict();
