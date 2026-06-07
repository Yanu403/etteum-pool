import { Hono } from "hono";
import { db } from "../db/index";
import { modelMappings, settings } from "../db/schema";
import { asc, eq } from "drizzle-orm";
import { invalidateModelMappingCache } from "../proxy/model-mapping";
import { getAllModels } from "../proxy/router";
import { broadcast } from "../ws/index";

export const integrationRouter = new Hono();

const MAPPING_ENABLED_SETTING = "model_mapping_enabled";
const VALID_MATCH_TYPES = new Set(["contains", "exact", "regex"]);

interface MappingInput {
  sourcePattern: string;
  matchType?: string;
  targetModel?: string;
  enabled?: boolean;
  priority?: number;
  label?: string | null;
}

async function getMasterEnabled(): Promise<boolean> {
  const [row] = await db.select().from(settings).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  return row?.value == null ? true : row.value !== "false";
}

async function setMasterEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  const existing = await db.select().from(settings).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, MAPPING_ENABLED_SETTING));
  } else {
    await db.insert(settings).values({ key: MAPPING_ENABLED_SETTING, value });
  }
}

/**
 * GET /api/integration - current mappings, master toggle, and the list of
 * models available in the pool (so the dashboard can offer them as targets).
 */
integrationRouter.get("/", async (c) => {
  const mappings = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  const enabled = await getMasterEnabled();
  const models = getAllModels().map((m) => ({ id: m.id, owned_by: m.owned_by }));
  return c.json({ enabled, mappings, models });
});

/**
 * PUT /api/integration - replace the full mapping set (and optional master
 * toggle) transactionally. Bulk-replace keeps the dashboard state model simple.
 */
integrationRouter.put("/", async (c) => {
  const body = await c.req.json<{ enabled?: boolean; mappings?: MappingInput[] }>();

  if (body.mappings !== undefined) {
    if (!Array.isArray(body.mappings)) {
      return c.json({ error: "mappings must be an array" }, 400);
    }

    const rows: Array<{
      sourcePattern: string;
      matchType: string;
      targetModel: string;
      enabled: boolean;
      priority: number;
      label: string | null;
    }> = [];

    for (const [i, m] of body.mappings.entries()) {
      const sourcePattern = (m.sourcePattern || "").trim();
      if (!sourcePattern) {
        return c.json({ error: `mappings[${i}]: sourcePattern is required` }, 400);
      }
      const matchType = m.matchType && VALID_MATCH_TYPES.has(m.matchType) ? m.matchType : "contains";
      if (matchType === "regex") {
        try {
          new RegExp(sourcePattern);
        } catch (e) {
          return c.json({ error: `mappings[${i}]: invalid regex: ${(e as Error).message}` }, 400);
        }
      }
      rows.push({
        sourcePattern,
        matchType,
        targetModel: (m.targetModel || "").trim(),
        enabled: m.enabled !== false,
        priority: Number.isFinite(m.priority) ? Number(m.priority) : i,
        label: m.label ?? null,
      });
    }

    // Bulk replace: clear then insert.
    await db.delete(modelMappings);
    if (rows.length > 0) {
      await db.insert(modelMappings).values(rows);
    }
  }

  if (typeof body.enabled === "boolean") {
    await setMasterEnabled(body.enabled);
  }

  invalidateModelMappingCache();
  broadcast({ type: "model_mappings_updated", data: {} });

  const mappings = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  const enabled = await getMasterEnabled();
  return c.json({ success: true, enabled, mappings });
});
