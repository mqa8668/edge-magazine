import { beforeEach, describe, expect, test } from "vitest";
import {
  getConfig,
  setConfig,
  DEFAULT_CONFIG,
  _resetConfigCache,
} from "../src/lib/runtime-config";
import { fakeEnv } from "./helpers";
import type { Bindings } from "../src/env";

beforeEach(() => _resetConfigCache());

describe("getConfig", () => {
  test("returns defaults when KV has no override", async () => {
    const env = fakeEnv() as unknown as Bindings;
    const cfg = await getConfig(env);
    expect(cfg.pipeline.postsPerDay).toBe(DEFAULT_CONFIG.pipeline.postsPerDay);
    expect(cfg.publish.mode).toBe("review");
  });

  test("safe defaults for a fresh install", async () => {
    const cfg = await getConfig(fakeEnv() as unknown as Bindings);
    expect(cfg.pipeline.enabled).toBe(false);
    expect(cfg.pipeline.postsPerDay).toBe(1);
    expect(cfg.llm.providerOrder).toEqual(["workers-ai"]);
    expect(cfg.seo.llmProviderOrder).toEqual(["workers-ai"]);
    expect(cfg.seo.gsc.enabled).toBe(false);
    expect(cfg.seo.gsc.siteUrl).toBe("");
    expect(cfg.photos.providerOrder).toEqual(["pexels"]);
  });

  test("deep-merges a partial KV override over defaults", async () => {
    const env = fakeEnv() as unknown as Bindings;
    await env.CACHE_KV.put(
      "cfg:v1",
      JSON.stringify({ pipeline: { postsPerDay: 5 }, publish: { mode: "auto" } }),
    );
    _resetConfigCache();
    const cfg = await getConfig(env);
    expect(cfg.pipeline.postsPerDay).toBe(5); // overridden
    expect(cfg.pipeline.backfillCount).toBe(DEFAULT_CONFIG.pipeline.backfillCount); // default kept
    expect(cfg.publish.mode).toBe("auto");
  });

  test("arrays are replaced wholesale, not merged", async () => {
    const env = fakeEnv() as unknown as Bindings;
    await env.CACHE_KV.put(
      "cfg:v1",
      JSON.stringify({ llm: { providerOrder: ["deepseek", "workers-ai"] } }),
    );
    _resetConfigCache();
    const cfg = await getConfig(env);
    expect(cfg.llm.providerOrder).toEqual(["deepseek", "workers-ai"]);
  });

  test("falls back to defaults on malformed KV JSON", async () => {
    const env = fakeEnv() as unknown as Bindings;
    await env.CACHE_KV.put("cfg:v1", "{not json");
    _resetConfigCache();
    const cfg = await getConfig(env);
    expect(cfg.pipeline.postsPerDay).toBe(DEFAULT_CONFIG.pipeline.postsPerDay);
  });
});

describe("setConfig", () => {
  test("persists the merged config and reports a leaf-level diff", async () => {
    const env = fakeEnv() as unknown as Bindings;
    const { config, diff } = await setConfig(
      env,
      { pipeline: { postsPerDay: 3 } },
      "admin",
    );
    expect(config.pipeline.postsPerDay).toBe(3);
    expect(diff).toEqual({ "pipeline.postsPerDay": { from: 1, to: 3 } });

    _resetConfigCache();
    const reread = await getConfig(env);
    expect(reread.pipeline.postsPerDay).toBe(3);
  });

  test("an unchanged save yields an empty diff", async () => {
    const env = fakeEnv() as unknown as Bindings;
    const { diff } = await setConfig(env, { publish: { mode: "review" } }, "admin");
    expect(Object.keys(diff)).toHaveLength(0);
  });
});
