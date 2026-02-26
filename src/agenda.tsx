// src/agenda-7d.tsx
import React from "react";
import { ActionPanel, Action, List, Icon } from "@vicinae/api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KHAL = "/usr/bin/khal";
const XDG_OPEN = "/usr/bin/xdg-open";

const FIXED_ENV = {
  ...process.env,
  PATH: "/usr/bin:/bin",
  HOME: "/home/pixor",
  XDG_CONFIG_HOME: "/home/pixor/.config",
  XDG_DATA_HOME: "/home/pixor/.local/share",
};

type KhalJsonItem = {
  title?: string;
  "start-date"?: string; // pode vir como YYYY-MM-DD ou DD/MM (seu caso)
  "start-time"?: string;
  "end-time"?: string;
  calendar?: string;
  location?: string;
  description?: string;
  url?: string;
  uid?: string;
  "all-day"?: boolean;
};

type Item = {
  title: string;
  dateISO: string; // YYYY-MM-DD
  startTime: string;
  endTime: string;
  calendar: string;
  url?: string;
};

function firstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/[^\s>")]+/i);
  return m?.[0];
}

function pickUrl(x: KhalJsonItem): string | undefined {
  return x.url || firstUrl(x.location || "") || firstUrl(x.description || "");
}

async function xdgOpen(url: string) {
  await execFileAsync(XDG_OPEN, [url], { timeout: 8000, env: FIXED_ENV });
}

function isoToday(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function sectionOf(
  dateISO: string,
  today: string,
): "today" | "tomorrow" | "next" | null {
  const tomorrow = addDaysISO(today, 1);
  const last = addDaysISO(today, 6);
  if (dateISO < today || dateISO > last) return null;
  if (dateISO === today) return "today";
  if (dateISO === tomorrow) return "tomorrow";
  return "next";
}

function normalizeStartDate(raw: string, today: string): string | null {
  const s = (raw || "").trim();

  // Caso 1: já veio ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Caso 2: veio DD/MM (seu caso)
  const m = s.match(/^(\d{2})\/(\d{2})$/);
  if (m) {
    const dd = m[1];
    const mm = m[2];
    const yyyy = today.slice(0, 4); // ano atual basta pra janela 7 dias
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function extractJsonArrays(stdout: string): KhalJsonItem[] {
  const out: KhalJsonItem[] = [];
  let i = 0;

  while (i < stdout.length) {
    const start = stdout.indexOf("[", i);
    if (start === -1) break;

    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let j = start; j < stdout.length; j++) {
      const ch = stdout[j];

      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }

      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "[") depth++;
      if (ch === "]") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) break;

    const block = stdout.slice(start, end + 1);
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed)) out.push(...(parsed as KhalJsonItem[]));
    } catch {}

    i = end + 1;
  }

  return out;
}

async function loadItems(): Promise<{ items: Item[]; debug: string }> {
  const args = [
    "list",
    "today",
    "7d",
    "--json",
    "title",
    "--json",
    "start-date",
    "--json",
    "start-time",
    "--json",
    "end-time",
    "--json",
    "calendar",
    "--json",
    "location",
    "--json",
    "description",
    "--json",
    "url",
    "--json",
    "uid",
    "--json",
    "all-day",
  ];

  try {
    const { stdout, stderr } = await execFileAsync(KHAL, args, {
      timeout: 20000,
      env: FIXED_ENV,
    });

    const arr = extractJsonArrays(stdout);
    const today = isoToday();

    const items = arr
      .map((x) => {
        const dateISO = normalizeStartDate(x["start-date"] || "", today);
        if (!dateISO) return null;

        const title = (x.title || "").trim() || "(Sem título)";
        const startTime =
          (x["start-time"] || "").trim() || (x["all-day"] ? "Dia todo" : "");
        const endTime = (x["end-time"] || "").trim();
        const calendar = (x.calendar || "").trim();
        const url = pickUrl(x);

        return {
          title,
          dateISO,
          startTime,
          endTime,
          calendar,
          url,
        } satisfies Item;
      })
      .filter(Boolean) as Item[];

    // Ordena por data/hora (Dia todo cai no topo do dia)
    items.sort((a, b) => {
      const at = `${a.dateISO} ${a.startTime === "Dia todo" ? "00:00" : a.startTime}`;
      const bt = `${b.dateISO} ${b.startTime === "Dia todo" ? "00:00" : b.startTime}`;
      return at.localeCompare(bt);
    });

    const debug = `stdout=${stdout.length} arrays=${arr.length} items=${items.length} stderr=${(
      stderr || ""
    )
      .trim()
      .slice(0, 120)}`;
    return { items, debug };
  } catch (e: any) {
    return {
      items: [],
      debug: `khal_error=${String(e?.message || e).slice(0, 300)}`,
    };
  }
}

export default function Agenda7d() {
  const [items, setItems] = React.useState<Item[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [debug, setDebug] = React.useState("");

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await loadItems();
      setItems(r.items);
      setDebug(r.debug);
      setLoading(false);
    })();
  }, []);

  const t = isoToday();
  const todayItems = items.filter((it) => sectionOf(it.dateISO, t) === "today");
  const tomorrowItems = items.filter(
    (it) => sectionOf(it.dateISO, t) === "tomorrow",
  );
  const nextItems = items.filter((it) => sectionOf(it.dateISO, t) === "next");

  const renderItem = (it: Item, idx: number) => (
    <List.Item
      key={`${it.dateISO}-${it.startTime}-${it.calendar}-${idx}`}
      title={it.title}
      subtitle={`${it.dateISO} ${it.startTime}${it.endTime ? " → " + it.endTime : ""}${
        it.calendar ? " • " + it.calendar : ""
      }${it.url ? " • link" : ""}`}
      icon={Icon.Calendar}
      actions={
        <ActionPanel>
          {it.url ? (
            <Action title="Abrir reunião" onAction={() => xdgOpen(it.url!)} />
          ) : (
            <Action.CopyToClipboard title="Copiar título" content={it.title} />
          )}
          {it.url ? (
            <Action.CopyToClipboard title="Copiar link" content={it.url} />
          ) : null}
        </ActionPanel>
      }
    />
  );

  return (
    <List
      isLoading={loading}
      searchBarPlaceholder="Agenda (Hoje/Amanhã/Próximos 5 dias)…"
    >
      <List.Section title="Hoje" subtitle={`${todayItems.length} eventos`}>
        {todayItems.map(renderItem)}
      </List.Section>

      <List.Section title="Amanhã" subtitle={`${tomorrowItems.length} eventos`}>
        {tomorrowItems.map(renderItem)}
      </List.Section>

      <List.Section
        title="Próximos 5 dias"
        subtitle={`${nextItems.length} eventos`}
      >
        {nextItems.map(renderItem)}
      </List.Section>

      {items.length === 0 ? (
        <List.EmptyView
          title="Sem eventos (ou khal não leu config)"
          description={debug}
        />
      ) : null}
    </List>
  );
}
