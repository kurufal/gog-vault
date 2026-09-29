import { normalizeTitle } from '../shared/domain';

type FileEvidence = { name: string; size: number };
export type MatchCandidate = { id: string; title: string; confidence: number; reasons: string[]; autoLink: boolean };

function similarity(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]!;
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const old = previous[column]!;
      previous[column] = Math.min(old + 1, previous[column - 1]! + 1, diagonal + Number(left[row - 1] !== right[column - 1]));
      diagonal = old;
    }
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length, 1);
}

export function scoreFolder(folder: string, game: { id: string; title: string; slug: string }, evidence: {
  metadataId?: string; localFiles?: FileEvidence[]; expectedFiles?: FileEvidence[]
}): MatchCandidate | null {
  if (evidence.metadataId && evidence.metadataId !== game.id) return null;
  const reasons: string[] = [];
  if (evidence.metadataId === game.id) return { id: game.id, title: game.title, confidence: 100, reasons: ['GOG Vault metadata contains this product ID'], autoLink: true };
  const name = normalizeTitle(folder);
  const title = normalizeTitle(game.title);
  const alias = normalizeTitle(game.slug);
  const exact = name === title;
  const aliasMatch = !exact && !!alias && alias === name;
  const closeness = similarity(name, title);
  if (!exact && !aliasMatch && closeness < 0.72) return null;
  let confidence = exact ? 76 : aliasMatch ? 72 : Math.min(82, Math.round(40 + closeness * 42));
  reasons.push(exact ? 'Exact normalized title' : aliasMatch ? 'Known GOG slug alias' : `Fuzzy title match (${Math.round(closeness * 100)}% text similarity)`);
  const local = evidence.localFiles || [];
  const expected = evidence.expectedFiles || [];
  const named = expected.find(file => local.some(item => item.name.toLowerCase() === file.name.toLowerCase()));
  const sized = expected.find(file => file.size > 0 && local.some(item => item.size === file.size && item.name.toLowerCase() === file.name.toLowerCase()));
  if (named) { confidence += 12; reasons.push(`Installer filename matched: ${named.name}`); }
  if (sized) { confidence += 8; reasons.push(`Installer size matched: ${sized.size} bytes`); }
  if (!evidence.metadataId) reasons.push('No GOG Vault product ID metadata');
  return { id: game.id, title: game.title, confidence: Math.min(99, confidence), reasons,
    autoLink: exact && !!named && !!sized && confidence >= 96 };
}