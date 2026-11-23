// FILE: api/src/robots.ts
// Robots exclusion rules: parsing and matching for the collector's user agent.

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

// robots.txt comes from the monitored site, so its size and pattern complexity are bounded.
const MAX_ROBOTS_CHARS = 100_000;
const MAX_RULES = 300;
const MAX_PATTERN_LENGTH = 200;
const MAX_WILDCARDS = 5;

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;

  for (const rawLine of text.slice(0, MAX_ROBOTS_CHARS).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", pattern: value });
      collectingAgents = false;
    }
  }
  return groups;
}

// Groups naming the agent win; the wildcard group applies only when no group names it.
function rulesFor(groups: Group[], agentToken: string): Rule[] {
  const named = groups.filter((group) => group.agents.includes(agentToken));
  const selected =
    named.length > 0
      ? named
      : groups.filter((group) => group.agents.includes("*"));
  return selected.flatMap((group) => group.rules).slice(0, MAX_RULES);
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Supports the * wildcard and a trailing $ anchor; overly complex patterns are ignored.
function compilePattern(pattern: string): RegExp | null {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return null;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  if (parts.length - 1 > MAX_WILDCARDS) return null;
  return new RegExp(
    `^${parts.map(escapeRegex).join(".*")}${anchored ? "$" : ""}`,
  );
}

// The most specific (longest) matching rule decides; Allow wins a tie. No matching rule means allowed.
export function isAllowedByRobots(
  robotsText: string,
  agentToken: string,
  pathWithQuery: string,
): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rulesFor(
    parseGroups(robotsText),
    agentToken.toLowerCase(),
  )) {
    const regex = compilePattern(rule.pattern);
    if (!regex || !regex.test(pathWithQuery)) continue;
    const length = rule.pattern.length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.allow && !best.allow)
    ) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}
