import type { DiagnosticCategory, ErrorSearchGateway } from "../application/diagnostics";

interface SearchTopic { Text?: unknown; FirstURL?: unknown; Topics?: unknown; }

export class DuckDuckGoErrorSearchGateway implements ErrorSearchGateway {
  public constructor(private readonly fetcher: typeof fetch = fetch) {}

  public async search(summary: string, category: DiagnosticCategory): Promise<Array<{ title: string; url: string }>> {
    const query = encodeURIComponent(`TriMusicAgent ${category} ${summary}`);
    const response = await this.fetcher(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`, { headers: { accept: "application/json" } });
    if (!response.ok) return [];
    const payload = await response.json() as { Results?: unknown; RelatedTopics?: unknown };
    const topics = [...toTopics(payload.Results), ...toTopics(payload.RelatedTopics)];
    const results: Array<{ title: string; url: string }> = [];
    for (const topic of topics) {
      if (Array.isArray(topic.Topics)) { topics.push(...toTopics(topic.Topics)); continue; }
      if (typeof topic.Text !== "string" || typeof topic.FirstURL !== "string" || !/^https:\/\//i.test(topic.FirstURL)) continue;
      results.push({ title: topic.Text.slice(0, 160), url: topic.FirstURL });
      if (results.length >= 5) break;
    }
    return results;
  }
}

function toTopics(value: unknown): SearchTopic[] { return Array.isArray(value) ? value.filter((item): item is SearchTopic => typeof item === "object" && item !== null && !Array.isArray(item)) : []; }
