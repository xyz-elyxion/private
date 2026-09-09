import { useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CrosshairMark } from './Landing';

import architecture from '../../docs/ARCHITECTURE.md?raw';
import deployment from '../../docs/DEPLOYMENT.md?raw';
import metricsApi from '../../docs/ADMIN-METRICS-API.md?raw';
import netcodeTcp from '../../docs/NETCODE-TCP-LOAD.md?raw';
import netcodeUdp from '../../docs/NETCODE-UDP-PLAN.md?raw';
import roadmap from '../../docs/ROADMAP.md?raw';
import communityMaps from '../../docs/community-maps.md?raw';
import distributionKit from '../../docs/distribution-kit.md?raw';
import originalPlan from '../../docs/instagib-arena-plan.md?raw';
import progression from '../../docs/progression.md?raw';

type Doc = {
  slug: string;
  title: string;
  description: string;
  content: string;
};

const DOCS: Doc[] = [
  { slug: 'architecture', title: 'Architecture', description: 'Client, server, netcode, and authority boundaries.', content: architecture },
  { slug: 'deployment', title: 'Deployment', description: 'Run Elyxion locally, in Docker, or on a PaaS.', content: deployment },
  { slug: 'metrics-api', title: 'Admin Metrics API', description: 'Read-only metrics and traffic endpoints.', content: metricsApi },
  { slug: 'netcode-tcp-load', title: 'TCP Snapshot Load', description: 'Load-harness methodology and baselines.', content: netcodeTcp },
  { slug: 'netcode-udp-plan', title: 'UDP Transport Plan', description: 'The WebTransport / QUIC migration plan.', content: netcodeUdp },
  { slug: 'roadmap', title: 'Roadmap', description: 'Shipped work, guiding principles, and what comes next.', content: roadmap },
  { slug: 'community-maps', title: 'Community Maps', description: 'The versioned JSON map format.', content: communityMaps },
  { slug: 'distribution-kit', title: 'Distribution Kit', description: 'Launch copy, listings, embeds, and store assets.', content: distributionKit },
  { slug: 'instagib-arena-plan', title: 'Original Design Plan', description: 'The original design rationale and aspirations.', content: originalPlan },
  { slug: 'progression', title: 'Progression System', description: 'XP, levels, credits, cosmetics, and challenges.', content: progression },
];

export default function Docs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSlug = searchParams.get('doc') || DOCS[0].slug;
  const activeDoc = DOCS.find((doc) => doc.slug === requestedSlug) ?? DOCS[0];

  const blocks = useMemo(() => parseMarkdown(activeDoc.content), [activeDoc.content]);

  const selectDoc = (slug: string) => {
    setSearchParams({ doc: slug });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="deck-bg min-h-screen text-white">
      <div className="deck-scan pointer-events-none fixed inset-0 z-10" aria-hidden="true" />
      <header className="relative z-20 border-b border-white/10 bg-black/30">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5 transition hover:text-cyan-200">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/60">
              Elyxion / Docs
            </span>
          </Link>
          <nav className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
            <Link to="/" className="transition hover:text-white/90">Home</Link>
            <Link to="/play" className="transition hover:text-white/90">Play ↗</Link>
          </nav>
        </div>
      </header>

      <main className="relative z-0 mx-auto grid max-w-7xl gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12 lg:py-12">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="mb-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300/80">Field manual</p>
            <h1 className="mt-2 font-display text-3xl font-bold uppercase tracking-[0.08em] text-white/90">Documentation</h1>
            <p className="mt-3 text-sm leading-relaxed text-white/45">
              Elyxion's technical and operational notes, presented as a readable site instead of raw Markdown files.
            </p>
          </div>
          <nav aria-label="Documentation sections" className="deck-panel clip-deck p-2">
            {DOCS.map((doc) => (
              <button
                key={doc.slug}
                type="button"
                onClick={() => selectDoc(doc.slug)}
                className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
                  activeDoc.slug === doc.slug
                    ? 'border-cyan-300 bg-cyan-300/10 text-cyan-100'
                    : 'border-transparent text-white/55 hover:border-white/25 hover:bg-white/5 hover:text-white/85'
                }`}
              >
                <span className="block font-display text-[12px] font-semibold uppercase tracking-[0.12em]">{doc.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-white/35">{doc.description}</span>
              </button>
            ))}
          </nav>
        </aside>

        <article className="deck-panel clip-deck min-w-0 px-5 py-7 sm:px-8 sm:py-10 lg:px-12">
          <div className="mb-8 border-b border-white/10 pb-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-white/35">Elyxion technical reference</p>
            <h2 className="mt-2 font-display text-4xl font-bold uppercase tracking-[0.05em] text-cyan-200 sm:text-5xl">
              {activeDoc.title}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">{activeDoc.description}</p>
          </div>
          <div className="docs-prose">{blocks.map((block, index) => renderBlock(block, index))}</div>
        </article>
      </main>

      <footer className="relative z-0 mx-auto max-w-7xl border-t border-white/10 px-5 py-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30 sm:px-8">
        Elyxion · Technical reference
      </footer>
    </div>
  );
}

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; language: string; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' };

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', language: fence[1].trim(), text: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        quote.push(lines[i].trimStart().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: quote.join(' ') });
      continue;
    }

    const listItem = line.match(/^\s*([-*+] |\d+[.] )(.+)$/);
    if (listItem) {
      const ordered = /^\d+[.] /.test(listItem[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(/^\s*([-*+] |\d+[.] )(.+)$/);
        if (!match || /^\d+[.] /.test(match[1]) !== ordered) break;
        items.push(match[2]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  return /^(#{1,6})\s|^```|^>|^\s*([-*+] |\d+[.] )/.test(line) || /^([-*_])(?:\s*\1){2,}$/.test(line.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderBlock(block: MarkdownBlock, index: number) {
  switch (block.type) {
    case 'heading': {
      const Tag = block.level <= 2 ? 'h3' : 'h4';
      return <Tag key={index} className={block.level <= 2 ? 'docs-heading' : 'docs-subheading'}>{inlineMarkdown(block.text)}</Tag>;
    }
    case 'paragraph':
      return <p key={index}>{inlineMarkdown(block.text)}</p>;
    case 'quote':
      return <blockquote key={index}>{inlineMarkdown(block.text)}</blockquote>;
    case 'code':
      return <pre key={index}><code>{block.text}</code></pre>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return <Tag key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</Tag>;
    }
    case 'table':
      return (
        <div key={index} className="docs-table-wrap">
          <table>
            <thead><tr>{block.headers.map((header) => <th key={header}>{inlineMarkdown(header)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inlineMarkdown(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr key={index} />;
  }
}

function inlineMarkdown(text: string) {
  const token = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = token.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[2] && match[3]) {
      const external = /^https?:\/\//.test(match[3]);
      nodes.push(<a key={key++} href={match[3]} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>{match[2]}</a>);
    } else if (match[4]) {
      nodes.push(<code key={key++}>{match[4]}</code>);
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={key++}>{match[5] || match[6]}</strong>);
    } else {
      nodes.push(<em key={key++}>{match[7] || match[8]}</em>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length ? nodes : text;
}
