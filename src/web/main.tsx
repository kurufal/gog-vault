import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FolderInput,
  HardDrive,
  LayoutGrid,
  List,
  LoaderCircle,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "@fontsource/audiowide/400.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { removeUnresolvedFolder, usedCapacity, type
  Game,
  Job,
  MediaAsset,
  RemoteFile,
  Settings,
  Platform,
  Category,
} from "../shared/domain";
import { playableVideoSource, uniqueMedia } from '../shared/media';
import { api, cancelGogLogin, diskCapacity, localArtwork, localMedia, streamedMedia, onGogAuthStatus, openUrl, pickVault, queueSocket, startGogLogin } from "./desktop";
import "./style.css";
import "./polish.css";

type Page = "dashboard" | "library" | "settings";
type Detail = { game: Game; files: RemoteFile[]; media: MediaAsset[] };
type OrganizeProposal = { id: string; title: string; current: string; proposed: string; conflict: boolean; conflictWith: string[]; confidence: 'high' | 'review' };
type MatchFolder = { folder: string; localPath: string; candidates: { id: string; title: string; confidence: number; reasons: string[] }[] };
type DownloadProposal = { id: string; title: string; files: number; bytes: number };
type ImportPlan = { source: string; files: number; bytes: number; signature: string; metadataId: string;
  candidates: { id: string; title: string; confidence: number; reasons: string[] }[]; error: string };
type Account = { connected: boolean; username: string; loginUrl: string; credentialError?: string };
type Storage = {
  writable: boolean;
  online: boolean;
  free: number | null;
  available: number | null;
  total: number | null;
  indexedBytes: number;
  appDataPath: string;
};
type Dashboard = {
  counts: Record<string, number>;
  activity: { at: string; message: string }[];
};
const fmt = (bytes: number) => {
  if (!bytes) return "0 B";
  const unit = bytes >= 1024 ** 4 ? 4 : bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : 1;
  return `${(bytes / 1024 ** unit).toFixed(unit === 4 ? 2 : 1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};
function columnValue(game: Game, label: string): string | number {
  if (label === "Main" || label === "DLC" || label === "Extras")
    return game.completion[label.toLowerCase() as Category] ?? -1;
  if (label === "Local Size") return game.localSize;
  if (label === "Remote Size") return game.remoteSize;
  if (label === "Updated") return game.refreshedAt;
  if (label === "Platforms") return game.platforms.join(",");
  if (label === "Status") return game.status;
  return game.title;
}
function Platforms({ platforms }: { platforms: Platform[] }) {
  return (
    <span className="platforms" aria-label={platforms.join(", ")}>
      {platforms.map((os) => (
        <span
          key={os}
          title={os === "mac" ? "macOS" : os}
          className="platform-icon"
        >
          {os === "windows" ? <FaWindows /> : os === "linux" ? <FaLinux /> : <FaApple />}
        </span>
      ))}
    </span>
  );
}
function Meter({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <strong>{value === null ? "N/A" : `${value}%`}</strong>
      </div>
      <div className="meter-track">
        <span style={{ width: `${value || 0}%` }} />
      </div>
    </div>
  );
}
function Artwork({
  game,
  type = "cover",
}: {
  game: Game;
  type?: "cover" | "background" | "logo";
}) {
  const [fallback, setFallback] = useState(false);
  const [local, setLocal] = useState("");
  const remote = type === "cover" ? game.cover : type === "logo" ? game.logo : game.background;
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (game.folder) void localArtwork(game.id, type).then(url => {
      objectUrl = url;
      if (active) setLocal(url);
      else URL.revokeObjectURL(url);
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); setLocal(""); };
  }, [game.id, game.folder, type]);
  const source = local && !fallback ? local : remote;
  return source ? (
    <img src={source} onError={() => setFallback(true)} alt="" loading="lazy" />
  ) : (
    <div className="art-placeholder">
      GV<span>ARCHIVE / {game.id}</span>
    </div>
  );
}
function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [games, setGames] = useState<Game[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState({
    running: false,
    done: 0,
    total: 0,
    error: "",
  });
  const [scan, setScan] = useState({
    running: false,
    done: 0,
    total: 0,
    error: "",
    phase: "",
    current: "",
    startedAt: "",
    unlinked: [] as string[],
    ignored: 0,
    cancelled: false,
  });
  const [unlinkedProduct, setUnlinkedProduct] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<MatchFolder[] | null>(null);
  const [matchSearch, setMatchSearch] = useState('');
  const [matchFilter, setMatchFilter] = useState('All');
  const [matchSort, setMatchSort] = useState('Confidence');
  const [organize, setOrganize] = useState<OrganizeProposal[] | null>(null);
  const [imports, setImports] = useState<ImportPlan[] | null>(null);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importMode, setImportMode] = useState<'copy' | 'move'>('copy');
  const [moveConfirmation, setMoveConfirmation] = useState('');
  const [downloadPreview, setDownloadPreview] = useState<DownloadProposal[] | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [os, setOs] = useState("All systems");
  const [sort, setSort] = useState("Title A-Z");
  const [columnSort, setColumnSort] = useState<{ label: string; descending: boolean } | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [code, setCode] = useState("");
  const [loginPending, setLoginPending] = useState(false);
  const [browserLogin, setBrowserLogin] = useState(false);

  const reload = async () => {
    const [library, queue, stats, progress, scanProgress] = await Promise.all([
      api<Game[]>("/games"),
      api<Job[]>("/queue"),
      api<Dashboard>("/dashboard"),
      api<typeof refresh>("/gog/library"),
      api<typeof scan>("/storage/scan"),
    ]);
    setGames(library);
    setJobs(queue);
    setDashboard(stats);
    setRefresh(progress);
    setScan(scanProgress);
  };
  const notify = async (action: () => Promise<unknown>, label = "Working") => {
    setBusy(label);
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const linkFolder = async (gameId: string, folder: string) => {
    setBusy('Linking folder');
    setError('');
    try {
      const game = await api<Game>(`/games/${gameId}/link`, 'POST', { folder });
      setGames(current => current.map(item => item.id === gameId ? game : item));
      setScan(current => ({ ...current, unlinked: removeUnresolvedFolder(current.unlinked, folder) }));
      setMatches(current => current?.filter(item => item.folder !== folder).map(item => ({ ...item, candidates: item.candidates.filter(candidate => candidate.id !== gameId) })) || null);
      setUnlinkedProduct(current => { const next = { ...current }; delete next[folder]; return next; });
      if (detail?.game.id === gameId) setDetail(await api<Detail>(`/games/${gameId}`));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  };
  const reviewMatches = async () => {
    try {
      const review = await api<{ folders: MatchFolder[]; ignored: number }>('/storage/matches');
      setMatches(review.folders);
      setScan(current => ({ ...current, ignored: review.ignored }));
    } catch (cause) { setError((cause as Error).message); }
  };
  const ignoreMatch = async (folder: string) => {
    setBusy('Ignoring folder');
    try {
      await api('/storage/matches/ignore', 'POST', { folder });
      setMatches(current => current?.filter(item => item.folder !== folder) || null);
      setScan(current => ({ ...current, unlinked: removeUnresolvedFolder(current.unlinked, folder), ignored: current.ignored + 1 }));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  };
  const previewOrganize = async () => {
    try { setOrganize(await api<OrganizeProposal[]>('/storage/organize')); }
    catch (cause) { setError((cause as Error).message); }
  };
  const previewImport = async () => {
    try {
      const path = await pickVault();
      if (!path) return;
      const plans = await api<ImportPlan[]>('/storage/import/preview', 'POST', { path });
      setImports(plans);
      setImportMapping(Object.fromEntries(plans.filter(item => item.metadataId).map(item => [item.source, item.metadataId])));
      setImportMode('copy'); setMoveConfirmation('');
    } catch (cause) { setError((cause as Error).message); }
  };
  const acceptImports = async () => {
    if (!imports || importMode === 'move' && moveConfirmation !== 'MOVE') return;
    const chosen = imports.filter(item => importMapping[item.source] && !item.error);
    setBusy(`Importing ${chosen.length} folders`); setError('');
    for (const item of chosen) {
      try {
        await api('/storage/import', 'POST', { source: item.source, id: importMapping[item.source], signature: item.signature, mode: importMode });
        setImports(current => current?.filter(plan => plan.source !== item.source) || null);
      } catch (cause) {
        setImports(current => current?.map(plan => plan.source === item.source ? { ...plan, error: (cause as Error).message } : plan) || null);
      }
    }
    try { await reload(); } catch (cause) { setError((cause as Error).message); }
    setBusy('');
  };
  const acceptOrganize = async (proposals: OrganizeProposal[]) => {
    await notify(async () => {
      for (const proposal of proposals) await api(`/storage/organize/${proposal.id}`, 'POST');
    }, 'Organizing vault');
    await previewOrganize();
  };
  const previewDownloads = async () => {
    try { setDownloadPreview(await api<DownloadProposal[]>('/library/download-preview')); }
    catch (cause) { setError((cause as Error).message); }
  };
  const acceptDownloads = async () => {
    if (!downloadPreview) return;
    await notify(async () => {
      const result = await api<{ started: { id: string }[]; skipped: { id: string; reason: string }[] }>('/library/download-missing', 'POST', { ids: downloadPreview.map(item => item.id) });
      setDownloadPreview(null);
      if (result.skipped.length) setError(`${result.started.length} queued; ${result.skipped.length} skipped: ${result.skipped.map(item => `${item.id}: ${item.reason}`).join('; ')}`);
    }, 'Queueing selected files');
  };
  useEffect(() => {
    void Promise.all([api<Settings>("/settings"), api<Account>("/gog/auth")])
      .then(([config, user]) => {
        setSettings(config);
        setAccount(user);
      })
      .catch((e) => setError(e.message));
    void reload().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void reload().catch(() => {});
    }, 6000);
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout>;
    let stopped = false;
    function connect() {
      void queueSocket().then(connection => {
        if (stopped) { connection.close(); return; }
        socket = connection;
        connection.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "queue") {
            setJobs(message.jobs);
            void api<Game[]>("/games").then(setGames);
          }
        } catch {}
        };
        connection.onclose = () => { if (!stopped) reconnect = setTimeout(connect, 3000); };
      }).catch(e => setError((e as Error).message));
    }
    connect();
    return () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(reconnect);
      if (socket) { socket.onclose = null; socket.close(); }
    };
  }, []);
  useEffect(() => {
    if (!settings?.vaultPath) { setStorage(null); return; }
    let active = true;
    const path = settings.vaultPath;
    const load = async () => {
      try {
        const info = await api<Storage>("/storage");
        const native = await diskCapacity(path).catch(() => null);
        if (active) setStorage({ ...info, total: native?.totalBytes ?? null, free: native?.freeBytes ?? null, available: native?.availableBytes ?? null });
      } catch { if (active) setStorage(null); }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => { active = false; clearInterval(timer); };
  }, [settings?.vaultPath]);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void onGogAuthStatus(status => {
      if (!active) return;
      setLoginPending(false);
      if (status === "connected") {
        void api<Account>("/gog/auth").then(setAccount).then(reload).catch((e) => setError((e as Error).message));
      } else if (status === "expired") {
        setError("GOG sign-in timed out. Try again or use browser login.");
      } else if (status === "error") {
        void api<Account>("/gog/auth").then(user => {
          setAccount(user);
          setError(user.credentialError || "GOG sign-in could not be completed. Try browser login if GOG blocked the desktop window.");
        }).catch(() => setError("GOG sign-in could not be completed. Check your connection and try again."));
      }
    }).then(stop => { if (active) unlisten = stop; else stop(); }).catch((e) => setError((e as Error).message));
    return () => { active = false; unlisten?.(); };
  }, []);
  const openGame = async (id: string) => {
    setError("");
    try {
      setDetail(await api<Detail>(`/games/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const updateDetail = async (path: string, method = "POST", body?: unknown) =>
    notify(async () => {
      const result = await api<Detail | Game>(path, method, body);
      if ("files" in result) setDetail(result);
      else await openGame(detail!.game.id);
    }, "Updating game");
  const changeSettings = async (input: Partial<Settings>) =>
    notify(async () => {
      setSettings(await api<Settings>("/settings", "PATCH", input));
    }, "Saving settings");
  const visible = games
    .filter(
      (g) =>
        g.title.toLowerCase().includes(search.toLowerCase()) &&
        (os === "All systems" || g.platforms.includes(os as Platform)) &&
        (filter === "All" ||
          (filter === "Vaulted"
            ? g.status === "Vaulted"
            : filter === "Missing"
              ? g.status === "Not Downloaded"
              : filter === "Updates"
                ? g.status === "Update Available"
                : filter === "Downloading"
                  ? ["Queued", "Downloading", "Paused", "Verifying"].includes(
                      g.status,
                    )
                  : g.status === filter)),
    )
    .sort((a, b) => {
      if (columnSort) {
        const left = columnValue(a, columnSort.label);
        const right = columnValue(b, columnSort.label);
        const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
        return columnSort.descending ? -order : order;
      }
      return sort === "Title Z-A"
        ? b.title.localeCompare(a.title)
        : sort === "Recently Added"
          ? b.firstSeen.localeCompare(a.firstSeen)
          : sort === "Recently Updated"
            ? b.refreshedAt.localeCompare(a.refreshedAt)
            : sort === "Local Size"
              ? b.localSize - a.localSize
              : sort === "Vault Status"
                ? a.status.localeCompare(b.status)
                : a.title.localeCompare(b.title);
    });
  const nav = (next: Page) => {
    setPage(next);
    setDetail(null);
  };

  return (
    <div className={`shell ${settings?.reducedMotion ? "reduced-motion" : ""}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => nav("dashboard")}>
          <span>
            <strong>GOG VAULT</strong>
            <small>OFFLINE ARCHIVE / 01</small>
          </span>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              ["dashboard", LayoutGrid, "Dashboard"],
              ["library", Database, "Library"],
              ["settings", Settings2, "Settings"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => nav(id)}
            >
              <Icon size={18} />
              {label}
              {id === "library" && (
                <span className="nav-count">{games.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="online-dot" />
          {account?.connected
            ? `CONNECTED / ${account.username}`
            : "ACCOUNT DISCONNECTED"}
          <small>LOCAL VAULT SYSTEM</small>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <h1 className="topbar-title">{page === 'dashboard' ? 'Dashboard' : page === 'library' ? 'Library' : 'Settings'}</h1>
          <div className="top-actions">
            <span className="top-status">
              <span className="online-dot" />{" "}
              {account?.connected ? "GOG CONNECTED" : "LOCAL MODE"}
            </span>
            <button
              className="icon-button queue-trigger"
              title="Toggle download queue"
              onClick={() => setQueueOpen(!queueOpen)}
            >
              <Download size={19} />
              <span className="queue-count">
                {
                  jobs.filter((j) =>
                    ["queued", "downloading", "paused", "verifying"].includes(
                      j.state,
                    ),
                  ).length
                }
              </span>
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="toast">
            <CircleAlert size={18} />
            {error}
            <button title="Dismiss" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {busy && (
          <div className="busy">
            <LoaderCircle size={15} className="spin" />
            {busy}
          </div>
        )}
        <div className="page-content">
          {page === "dashboard" && (
            <>
              {!account?.connected && <button className="secondary-button" onClick={() => nav('settings')}>Connect GOG <ArrowRight size={16} /></button>}
              <div className="section-header">
                <h2>Archive telemetry</h2>
                <span>LIVE INDEX / {new Date().toLocaleDateString()}</span>
              </div>
              <div className="stats-grid">
                {(
                  [
                    ["Owned Games", "owned", Database],
                    ["Vaulted", "vaulted", ShieldCheck],
                    ["Missing", "missing", ArrowDownToLine],
                    ["Incomplete", "incomplete", CircleAlert],
                    ["Updates Available", "updates", RefreshCw],
                    ["Downloading", "downloading", Download],
                    ["Errors", "errors", Activity],
                  ] as const
                ).map(([label, key, Icon]) => (
                  <div className="stat" key={key}>
                    <div className="stat-top">
                      <span>{label}</span>
                      <Icon size={19} />
                    </div>
                    <strong>{dashboard?.counts[key] || 0}</strong>
                    <div className="stat-rule" />
                  </div>
                ))}
                <div className="stat storage-stat">
                  <div className="stat-top">
                    <span>Vault / Free space</span>
                    <HardDrive size={19} />
                  </div>
                  <strong>{fmt(dashboard?.counts.size || 0)}</strong>
                  <small>{storage?.available == null ? "CAPACITY UNAVAILABLE" : `${fmt(storage.available)} AVAILABLE`}</small>
                </div>
              </div>
              <div className="section-header">
                <h2>Recent activity</h2>
                <span>EVENT LOG</span>
              </div>
              <div className="activity-list">
                {dashboard?.activity.length ? (
                  dashboard.activity.map((event, index) => (
                    <div key={`${event.at}-${index}`} className="activity-row">
                      <span className="event-dot" />
                      <span>{event.message}</span>
                      <time>{new Date(event.at).toLocaleString()}</time>
                    </div>
                  ))
                ) : (
                  <div className="empty-inline">
                    No activity yet. Connect your account or scan an existing
                    vault to begin.
                  </div>
                )}
              </div>
            </>
          )}
          {page === "library" && (
            <>
              <div className="page-heading inline-heading">
                <button
                  className="secondary-button"
                  disabled={!account?.connected || !!busy || refresh.running}
                  onClick={() =>
                    notify(async () => {
                      await api("/gog/library", "POST");
                    }, "Starting refresh")
                  }
                >
                  <RefreshCw size={16} />
                  Refresh library
                </button>
              </div>
              {refresh.running && (
                <div className="refresh-progress">
                  <LoaderCircle size={16} className="spin" />
                  Refreshing metadata {refresh.done} / {refresh.total}
                </div>
              )}
              <div className="library-tools">
                {settings?.vaultPath && <button className="secondary-button" disabled={scan.running} onClick={() => void notify(() => api('/storage/scan', 'POST'), 'Starting scan')}><Search size={16} />Scan Directory</button>}
                {settings?.vaultPath && <button className="secondary-button" disabled={!!busy} onClick={() => void previewDownloads()}><Download size={16} />Download missing</button>}
                {settings?.vaultPath && <button className="secondary-button" onClick={() => void previewOrganize()}><HardDrive size={16} />Organize vault</button>}
                {settings?.vaultPath && <button className="secondary-button" disabled={!!busy} onClick={() => void previewImport()}><FolderInput size={16} />Import Games</button>}
                <div className="search-wrap">
                  <Search size={18} />
                  <input
                    aria-label="Search games"
                    placeholder="Search your games..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <select
                  aria-label="Filter platform"
                  value={os}
                  onChange={(event) => setOs(event.target.value)}
                >
                  <option>All systems</option>
                  <option value="windows">Windows</option>
                  <option value="linux">Linux</option>
                  <option value="mac">macOS</option>
                </select>
                <select
                  aria-label="Sort games"
                  value={sort}
                  onChange={(event) => { setSort(event.target.value); setColumnSort(null); }}
                >
                  {[
                    "Title A-Z",
                    "Title Z-A",
                    "Recently Added",
                    "Recently Updated",
                    "Local Size",
                    "Vault Status",
                  ].map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
                <div className="view-switch">
                  <button
                    title="Tile view"
                    aria-label="Tile view"
                    className={settings?.view !== "list" ? "active" : ""}
                    onClick={() => void changeSettings({ view: "tiles" })}
                  >
                    <LayoutGrid size={17} />
                  </button>
                  <button
                    title="List view"
                    aria-label="List view"
                    className={settings?.view === "list" ? "active" : ""}
                    onClick={() => void changeSettings({ view: "list" })}
                  >
                    <List size={17} />
                  </button>
                </div>
              </div>
              <div className="filter-row">
                {[
                  "All",
                  "Vaulted",
                  "Missing",
                  "Incomplete",
                  "Downloading",
                  "Updates",
                  "Errors",
                ].map((label) => (
                  <button
                    key={label}
                    className={filter === label ? "selected" : ""}
                    onClick={() => setFilter(label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="results-line">
                SHOWING {visible.length} OF {games.length} GAMES
              </div>
              {visible.length ? (
                settings?.view === "list" ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {[
                            "Title",
                            "Platforms",
                            "Main",
                            "DLC",
                            "Extras",
                            "Status",
                            "Local Size",
                            "Remote Size",
                            "Updated",
                            "Actions",
                          ].map((label) => (
                            <th key={label}>{label === "Actions" ? label : <button className="sort-header" aria-label={`Sort by ${label}`} onClick={() => setColumnSort({ label, descending: columnSort?.label === label ? !columnSort.descending : false })}>{label}{columnSort?.label === label && <ChevronDown size={13} style={{ transform: columnSort.descending ? 'none' : 'rotate(180deg)' }} />}</button>}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((game) => (
                          <tr
                            key={game.id}
                            onClick={() => void openGame(game.id)}
                          >
                            <td className="table-title">
                              <div className="mini-cover">
                                <Artwork game={game} />
                              </div>
                              {game.title}{games.some(other => other.id !== game.id && other.title === game.title) && <small className="product-disambiguation">Product {game.id}</small>}
                            </td>
                            <td>
                              <Platforms platforms={game.platforms} />
                            </td>
                            {(["main", "dlc", "extras"] as const).map((key) => (
                              <td key={key}>
                                {game.completion[key] === null
                                  ? "N/A"
                                  : `${game.completion[key]}%`}
                              </td>
                            ))}
                            <td>
                              <span
                                className={`status ${game.status.toLowerCase().replaceAll(" ", "-")}`}
                              >
                                {game.status}
                              </span>
                            </td>
                            <td>{fmt(game.localSize)}</td>
                            <td>{fmt(game.remoteSize)}</td>
                            <td>
                              {game.refreshedAt
                                ? new Date(
                                    game.refreshedAt,
                                  ).toLocaleDateString()
                                : "-"}
                            </td>
                            <td>
                              <button
                                className="table-action"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openGame(game.id);
                                }}
                                title="Open details"
                              >
                                <ArrowRight size={17} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="game-grid">
                    {visible.map((game) => (
                      <button
                        className="game-card"
                        key={game.id}
                        onClick={() => void openGame(game.id)}
                      >
                        <div className="game-art">
                          <Artwork game={game} type="logo" />
                          {game.status === "Update Available" && (
                            <span className="update-tag">UPDATE</span>
                          )}
                        </div>
                        <div className="game-info">
                          <h3>{game.title}</h3>
                          {games.some(other => other.id !== game.id && other.title === game.title) && <small className="product-disambiguation">GOG product {game.id}</small>}
                          <div className="game-sub">
                            <Platforms platforms={game.platforms} />
                            <span
                              className={`status ${game.status.toLowerCase().replaceAll(" ", "-")}`}
                            >
                              {game.status}
                            </span>
                          </div>
                          <div className="compact-meters">
                            {(["main", "dlc", "extras"] as const).map((key) => (
                              <div key={key}>
                                <span>{key.toUpperCase()}</span>
                                <strong>
                                  {game.completion[key] === null
                                    ? "N/A"
                                    : `${game.completion[key]}%`}
                                </strong>
                                <i
                                  style={{
                                    width: `${game.completion[key] || 0}%`,
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <div className="empty-state">
                  <Database size={35} />
                  <h3>
                    {games.length
                      ? "No matching games"
                      : "Library awaiting sync"}
                  </h3>
                  <p>
                    {games.length
                      ? "Try another filter or search term."
                      : account?.connected
                        ? "Refresh your library to index owned games."
                        : "Connect your GOG account in Settings to import your games."}
                  </p>
                </div>
              )}
            </>
          )}
          {page === "settings" && (
            <>
              <div className="settings-layout">
                <section className="settings-section">
                  <div className="section-title">
                    <ShieldCheck size={21} />
                    <div>
                      <h2>GOG Account</h2>
                      <p>Connect securely through GOG's own sign-in page.</p>
                    </div>
                  </div>
                  {account?.connected ? (
                    <div className="account-connected">
                      <span className="online-dot" />
                      Connected as <strong>{account.username}</strong>
                      <p className="field-help">{games.length} games · Last refresh {games.some(game => game.refreshedAt) ? new Date(Math.max(...games.map(game => Date.parse(game.refreshedAt) || 0))).toLocaleDateString() : "not yet"}</p>
                      <button
                        className="text-danger"
                        onClick={() =>
                          void notify(async () => {
                            await api("/gog/auth", "DELETE");
                            setAccount(await api("/gog/auth"));
                          }, "Disconnecting")
                        }
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <>
                      {account?.credentialError && <p className="field-help error-text">{account.credentialError}</p>}
                      <button
                        className="primary-button"
                        disabled={!account?.loginUrl || loginPending || !!busy}
                        onClick={() => {
                          if (!account?.loginUrl) return;
                          setError("");
                          setLoginPending(true);
                          void startGogLogin(account.loginUrl).catch((e) => {
                            setLoginPending(false);
                            setError(`Could not open GOG sign-in: ${String(e)}. Use browser login instead.`);
                          });
                        }}
                      >
                        {loginPending ? "Waiting for GOG sign-in" : "Connect GOG"} <ArrowRight size={16} />
                      </button>
                      {loginPending && <button className="secondary-button" onClick={() => void cancelGogLogin().catch((e) => setError(String(e)))}>Cancel sign-in</button>}
                      <p className="field-help">Sign in on GOG's page. Your password never enters GOG Vault.</p>
                      <button className="secondary-button" onClick={() => setBrowserLogin(!browserLogin)} aria-expanded={browserLogin}>Use browser instead</button>
                      {browserLogin && (
                        <div>
                          <p className="field-help">For sign-in pages that do not work in the desktop window, open GOG in your browser and paste the redirect URL or code here.</p>
                          <button className="secondary-button" disabled={loginPending || !account?.loginUrl} onClick={() => { if (account?.loginUrl) void openUrl(account.loginUrl).catch((e) => setError(String(e))); }}>Open GOG in browser <ArrowRight size={16} /></button>
                          <div className="field-row">
                            <input
                              aria-label="GOG authorization URL or code"
                              type="text"
                              autoComplete="off"
                              placeholder="Paste the GOG redirect URL or code"
                              value={code}
                              onChange={(event) => setCode(event.target.value)}
                            />
                            <button
                              className="secondary-button"
                              disabled={!code || !!busy || loginPending}
                              onClick={() =>
                                void notify(async () => {
                                  await api("/gog/auth", "POST", { code });
                                  setCode("");
                                  setAccount(await api("/gog/auth"));
                                }, "Connecting account")
                              }
                            >
                              Finish
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  {account?.connected && (
                    <button
                      className="secondary-button"
                      disabled={refresh.running || !!busy}
                      onClick={() =>
                        void notify(
                          () => api("/gog/library", "POST"),
                          "Starting refresh",
                        )
                      }
                    >
                      <RefreshCw size={16} />
                      Refresh library
                    </button>
                  )}
                  {refresh.running && (
                    <p className="field-help">
                      Refreshing {refresh.done} / {refresh.total} games...
                    </p>
                  )}
                  {refresh.error && (
                    <p className="field-help error-text">{refresh.error}</p>
                  )}
                </section>
                <section className="settings-section">
                  <div className="section-title">
                    <HardDrive size={21} />
                    <div>
                      <h2>Storage</h2>
                      <p>Choose a local drive or network share for your archive.</p>
                    </div>
                  </div>
                  <div className="setting-line">
                    <span>GAME VAULT LOCATION</span>
                    <strong>
                      {settings?.vaultPath || "No vault selected"}
                    </strong>
                  </div>
                  <div className="setting-line">
                    <span>VAULT SIZE (INDEXED)</span>
                    <strong>
                      {storage ? fmt(storage.indexedBytes) : "Scan vault to index files"}
                    </strong>
                  </div>
                  <div className="setting-line"><span>{settings?.vaultPath.startsWith('\\\\') ? 'SHARE CAPACITY' : 'DRIVE CAPACITY'}</span><strong>{storage?.total == null ? "Capacity unavailable" : fmt(storage.total)}</strong></div>
                  <div className="setting-line"><span>{settings?.vaultPath.startsWith('\\\\') ? 'USED ON SHARE' : 'USED ON DRIVE'}</span><strong>{storage && usedCapacity(storage.total, storage.free) !== null ? fmt(usedCapacity(storage.total, storage.free)!) : "Capacity unavailable"}</strong></div>
                  <div className="setting-line"><span>FREE SPACE</span><strong>{storage?.available == null ? "Capacity unavailable" : fmt(storage.available)}</strong></div>
                  <div className="setting-line"><span>STORAGE</span><strong>{storage ? "Online" : settings?.vaultPath ? "Unavailable" : "Not configured"}</strong></div>
                  <div className="setting-line">
                    <span>Writable</span>
                    <strong>
                      {storage
                        ? storage.writable
                          ? "Yes"
                          : "No"
                        : "Check directory"}
                    </strong>
                  </div>
                  <details className="app-data-info"><summary>App Data</summary><p>Database, settings, cache, logs and queue state</p><strong>{storage?.appDataPath || "Managed separately by GOG Vault"}</strong></details>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      onClick={() => void notify(async () => {
                        const path = await pickVault();
                        if (path) {
                          setSettings(await api<Settings>("/storage/select", "POST", { path }));
                          setStorage(null);
                        }
                      }, "Selecting storage")}
                    >
                      <HardDrive size={16} />
                      Choose vault folder
                    </button>
                    <button
                      className="secondary-button"
                      disabled={scan.running}
                      onClick={() =>
                        void notify(
                          () => api("/storage/scan", "POST"),
                          "Starting scan",
                        )
                      }
                    >
                      <Search size={16} />
                      Scan Directory
                    </button>
                    {scan.running && <button className="secondary-button" onClick={() => void api('/storage/scan/cancel', 'POST').catch((e) => setError(String(e)))}><Square size={15} />Cancel scan</button>}
                    {settings?.vaultPath && <button className="secondary-button" onClick={() => void previewOrganize()}><HardDrive size={16} />Preview organization</button>}
                  </div>
                  {scan.running && (
                    <p className="field-help">
                      {scan.phase}: {scan.done} / {scan.total} games {scan.current && `· ${scan.current}`}
                    </p>
                  )}
                  <div className="match-summary"><strong>Directory scan</strong><span>Last scan: {scan.startedAt ? new Date(scan.startedAt).toLocaleString() : 'Not yet'}</span><span>Games matched: {games.filter(game => game.folder).length}</span><span>Needs matching: {scan.unlinked.length}</span><span>Ignored folders: {scan.ignored}</span><button className="secondary-button" disabled={!scan.unlinked.length} onClick={() => void reviewMatches()}>Review matches</button></div>
                  {scan.error && (
                    <p className="field-help error-text">{scan.error}</p>
                  )}
                </section>
                <section className="settings-section downloads-section">
                  <div className="section-title">
                    <Download size={21} />
                    <div>
                      <h2>Downloads</h2>
                    </div>
                  </div>
                  {settings && (
                    <div className="settings-fields download-settings">
                      <div className="defaults-choices"><strong>Platforms</strong>{(['windows', 'linux', 'mac'] as Platform[]).map(value => <label className="checkbox-line" key={value}><input type="checkbox" checked={settings.platforms.includes(value)} onChange={event => void changeSettings({ platforms: event.target.checked ? [...settings.platforms, value] : settings.platforms.filter(item => item !== value) })} />{value === 'mac' ? 'macOS' : value}</label>)}</div>
                      <div className="defaults-choices language-choices"><strong>Languages</strong><div>{[...new Set(['English', ...games.flatMap(game => game.languages), ...settings.languages])].map(value => <label className="checkbox-line" key={value}><input type="checkbox" checked={settings.languages.includes(value)} onChange={event => void changeSettings({ languages: event.target.checked ? [...settings.languages, value] : settings.languages.filter(item => item !== value) })} />{value}</label>)}</div></div>
                      <div className="download-group"><strong>Transfer</strong><label>
                        Concurrent games
                        <input
                          type="number"
                          min="1"
                          max="8"
                          value={settings.concurrency}
                          onChange={(event) =>
                            void changeSettings({
                              concurrency: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Retry count
                        <input
                          type="number"
                          min="0"
                          max="10"
                          value={settings.retries}
                          onChange={(event) =>
                            void changeSettings({
                              retries: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Timeout (seconds)
                        <input
                          type="number"
                          min="10"
                          max="3600"
                          value={settings.timeout}
                          onChange={(event) =>
                            void changeSettings({
                              timeout: Number(event.target.value),
                            })
                          }
                        />
                      </label></div>
                      <div className="download-group"><strong>Content</strong><span className="fixed-default">Main installers · always selected</span>
                      <label className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={settings.dlc}
                          onChange={(event) =>
                            void changeSettings({ dlc: event.target.checked })
                          }
                        />
                        Select DLC by default
                      </label>
                      <label className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={settings.extras}
                          onChange={(event) =>
                            void changeSettings({
                              extras: event.target.checked,
                            })
                          }
                        />
                        Select extras by default
                      </label>
                      <label className="checkbox-line"><input type="checkbox" checked={settings.storeImages} onChange={event => void changeSettings({ storeImages: event.target.checked })} />Archive store images by default</label>
                      <label className="checkbox-line"><input type="checkbox" checked={settings.storeVideos} onChange={event => void changeSettings({ storeVideos: event.target.checked })} />Archive store videos by default</label>
                      <label className="checkbox-line"><input type="checkbox" checked={settings.patches} onChange={event => void changeSettings({ patches: event.target.checked })} />Select patches by default</label>
                      <label className="checkbox-line"><input type="checkbox" checked={settings.languagePacks} onChange={event => void changeSettings({ languagePacks: event.target.checked })} />Select language packs by default</label></div>
                    </div>
                  )}
                </section>
                <section className="settings-section">
                  <div className="section-title">
                    <RefreshCw size={21} />
                    <h2>Automation</h2>
                  </div>
                  {settings && <><label className="checkbox-line"><input type="checkbox" checked={settings.autoRefresh} onChange={event => void changeSettings({ autoRefresh: event.target.checked })} />Refresh GOG library at launch</label><label className="checkbox-line"><input type="checkbox" checked={settings.autoScan} onChange={event => void changeSettings({ autoScan: event.target.checked })} />Scan Directory at launch</label></>}
                </section>
                <section className="settings-section">
                  <div className="section-title"><SlidersHorizontal size={21} /><h2>Application</h2></div>
                  {settings && (
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={settings.reducedMotion}
                        onChange={(event) =>
                          void changeSettings({
                            reducedMotion: event.target.checked,
                          })
                        }
                      />
                      Reduce motion
                    </label>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </main>
      {matches && <div className="organize-backdrop" role="presentation" onClick={() => setMatches(null)}><section role="dialog" aria-modal="true" aria-label="Match existing folders" className="organize-dialog matches-dialog" onClick={event => event.stopPropagation()}><div className="organize-header"><h2>Match existing folders</h2><button title="Close matches" aria-label="Close matches" onClick={() => setMatches(null)}><X size={18} /></button></div><p>{matches.length ? `${matches.length} folders need attention` : 'No folders need matching.'}</p>{matches.length > 0 && <div className="match-filters"><input aria-label="Search folders" placeholder="Search folders" value={matchSearch} onChange={event => setMatchSearch(event.target.value)} /><select aria-label="Filter match confidence" value={matchFilter} onChange={event => setMatchFilter(event.target.value)}><option>All</option><option>High confidence</option><option>Low confidence</option></select><select aria-label="Sort matches" value={matchSort} onChange={event => setMatchSort(event.target.value)}><option>Confidence</option><option>Folder name</option></select></div>}<div className="organize-list">{matches.filter(item => (!matchSearch || item.folder.toLowerCase().includes(matchSearch.toLowerCase()) || item.candidates.some(candidate => candidate.title.toLowerCase().includes(matchSearch.toLowerCase()))) && (matchFilter === 'All' || (item.candidates[0]?.confidence || 0) >= 85 === (matchFilter === 'High confidence'))).sort((left, right) => matchSort === 'Folder name' ? left.folder.localeCompare(right.folder) : (right.candidates[0]?.confidence || 0) - (left.candidates[0]?.confidence || 0)).map(item => { const suggested = item.candidates[0]; const selected = unlinkedProduct[item.folder] || (suggested && suggested.confidence >= 70 ? suggested.id : ''); const choice = item.candidates.find(candidate => candidate.id === selected); return <div className="organize-item match-item" key={item.folder}><strong>{item.folder}</strong><span>Local folder: {item.localPath}</span><span>Best match: {suggested ? `${suggested.title} · GOG ${suggested.id}` : 'No reliable suggestion'}</span><span>Match confidence: {suggested ? `${suggested.confidence}%` : 'Unavailable'}</span>{suggested && <details><summary>Match evidence</summary><ul>{suggested.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}<div className="unlinked-controls"><select aria-label={`Match ${item.folder} to product`} value={selected} onChange={event => setUnlinkedProduct(current => ({ ...current, [item.folder]: event.target.value }))}><option value="">Select GOG product</option>{item.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title} · GOG {candidate.id} ({candidate.confidence}%)</option>)}{games.filter(game => !game.folder && !item.candidates.some(candidate => candidate.id === game.id)).map(game => <option key={game.id} value={game.id}>{game.title} · GOG {game.id}</option>)}</select><button className="primary-button" disabled={!selected || !!busy} onClick={() => void linkFolder(selected, item.folder)}>Link</button><button className="secondary-button" disabled={!!busy} onClick={() => void ignoreMatch(item.folder)}>Ignore folder</button></div>{choice && choice !== suggested && <small>Selected GOG {choice.id}: {choice.confidence}% · {choice.reasons.join('; ')}</small>}</div>; })}</div><div className="settings-actions"><button className="secondary-button" onClick={() => setMatches(null)}>Close</button></div></section></div>}
      {downloadPreview && <div className="organize-backdrop" role="presentation" onClick={() => setDownloadPreview(null)}><section role="dialog" aria-modal="true" aria-label="Download missing preview" className="organize-dialog" onClick={event => event.stopPropagation()}><div className="organize-header"><h2>Download missing</h2><button title="Close preview" aria-label="Close preview" onClick={() => setDownloadPreview(null)}><X size={18} /></button></div><p>{downloadPreview.length} games · {downloadPreview.reduce((sum, item) => sum + item.files, 0)} selected missing files · {fmt(downloadPreview.reduce((sum, item) => sum + item.bytes, 0))}. Existing matched files are excluded.</p><div className="organize-list">{downloadPreview.map(item => <div className="organize-item" key={item.id}><strong>{item.title} <small>GOG {item.id}</small></strong><span>{item.files} files · {fmt(item.bytes)}</span></div>)}</div><div className="settings-actions"><button className="primary-button" disabled={!downloadPreview.length || !!busy} onClick={() => void acceptDownloads()}>Add to queue</button><button className="secondary-button" onClick={() => setDownloadPreview(null)}>Cancel</button></div></section></div>}
      {imports && <div className="organize-backdrop" role="presentation" onClick={() => { if (!busy) setImports(null); }}><section role="dialog" aria-modal="true" aria-label="Import Games preview" className="organize-dialog matches-dialog" onClick={event => event.stopPropagation()}>
        <div className="organize-header"><h2>Import Games</h2><button title="Close import" disabled={!!busy} onClick={() => setImports(null)}><X size={18} /></button></div>
        <p>{imports.length} folders · {fmt(imports.reduce((sum, item) => sum + item.bytes, 0))}. Review every product ID before copying. Existing vault folders are never overwritten.</p>
        <div className="organize-list">{imports.map(item => <div className="organize-item" key={item.source}>
          <strong>{item.source.split(/[\\/]/).pop()}</strong><span>{item.source}</span><small>{item.files} files · {fmt(item.bytes)}{item.metadataId ? ` · Local metadata: GOG ${item.metadataId}` : ''}</small>
          {item.error ? <span role="alert" className="import-error">{item.error}</span> : <><label className="import-map">GOG product ID
            <input list="import-products" value={importMapping[item.source] || ''} onChange={event => setImportMapping(old => ({ ...old, [item.source]: event.target.value }))} placeholder="Choose or enter a product ID" aria-label={`Product ID for ${item.source}`} />
          </label><small>{item.candidates.map(candidate => `${candidate.title} (${candidate.id}, ${candidate.confidence}%)`).join(' · ') || 'No suggested match; enter a GOG product ID to continue.'}</small></>}
        </div>)}</div>
        <datalist id="import-products">{games.filter(game => !game.folder).map(game => <option key={game.id} value={game.id} label={game.title} />)}</datalist>
        <div className="import-mode" role="group" aria-label="Import mode"><button className={importMode === 'copy' ? 'selected' : ''} onClick={() => setImportMode('copy')}>Copy</button><button className={importMode === 'move' ? 'selected' : ''} onClick={() => setImportMode('move')}>Move</button></div>
        {importMode === 'move' && <label className="import-map">Source files are removed only after the vault copy is SHA-256 checked. Type MOVE to confirm<input value={moveConfirmation} onChange={event => setMoveConfirmation(event.target.value)} aria-label="Type MOVE to confirm source removal" /></label>}
        <div className="settings-actions"><button className="primary-button" disabled={!!busy || !imports.some(item => !item.error && importMapping[item.source]) || importMode === 'move' && moveConfirmation !== 'MOVE'} onClick={() => void acceptImports()}>Import selected ({importMode})</button><button className="secondary-button" disabled={!!busy} onClick={() => setImports(null)}>Close</button></div>
      </section></div>}
      {organize && <div className="organize-backdrop" role="presentation" onClick={() => setOrganize(null)}><section role="dialog" aria-modal="true" aria-label="Organize vault preview" className="organize-dialog" onClick={event => event.stopPropagation()}><div className="organize-header"><h2>Organize vault</h2><button title="Close preview" aria-label="Close preview" onClick={() => setOrganize(null)}><X size={18} /></button></div><p>Review folder names before any change. Installer files remain inside their current game folder.</p>{organize.length ? <><div className="organize-list">{organize.map(proposal => <div className="organize-item" key={proposal.id}><strong>{proposal.title} <small>GOG {proposal.id}</small></strong><span>{proposal.current}</span><span>→ {proposal.proposed}</span><small>{proposal.conflict ? `Destination occupied${proposal.conflictWith.length ? ` or mapped to GOG ${proposal.conflictWith.join(', ')}` : ''} — keep current` : proposal.confidence === 'high' ? 'Product ID confirmed by local metadata' : 'Linked folder — review before accepting'}</small><button className="secondary-button" disabled={proposal.conflict || !!busy} onClick={() => void acceptOrganize([proposal])}>Accept rename</button></div>)}</div><div className="settings-actions"><button className="secondary-button" disabled={!!busy || !organize.some(item => !item.conflict && item.confidence === 'high')} onClick={() => void acceptOrganize(organize.filter(item => !item.conflict && item.confidence === 'high'))}>Accept all high-confidence</button><button className="secondary-button" onClick={() => setOrganize(null)}>Keep current names</button></div></> : <p>All linked game folders already use their suggested names.</p>}</section></div>}
      <div
        className={`queue-overlay ${queueOpen ? "visible" : ""}`}
        onClick={() => setQueueOpen(false)}
      />
      <aside
        className={`queue-panel ${queueOpen ? "open" : ""}`}
        aria-label="Download queue"
      >
        <div className="queue-header">
          <div>
            <div className="eyebrow">TRANSFER CONTROL</div>
            <h2>
              Download queue <span>{jobs.length}</span>
            </h2>
          </div>
          <button
            className="icon-button"
            title="Close queue"
            onClick={() => setQueueOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="queue-items">
          {jobs.length ? (
            jobs.map((job) => {
              const game = games.find((item) => item.id === job.gameId);
              return (
                <div className="queue-item" key={job.id}>
                  <div className="queue-game">
                    <div className="queue-thumb">
                      {game && <Artwork game={game} />}
                    </div>
                    <div>
                      <strong>{game?.title || job.gameId}</strong>
                      <small>
                        {job.state.toUpperCase()} ·{" "}
                        {game?.platforms.join(" / ")}
                      </small>
                    </div>
                  </div>
                  <p className="queue-filename">
                    {job.state === 'error' ? job.error || 'Download failed' : job.currentFile || 'Waiting in queue'}
                  </p>
                  {job.state === 'error' && job.errorDetails && <div className="queue-failure">
                    <strong>{job.errorDetails.partNumber ? `Part ${job.errorDetails.partNumber} · ` : ''}{job.errorDetails.stage.replaceAll('_', ' ')}{job.errorDetails.httpStatus ? ` · HTTP ${job.errorDetails.httpStatus}` : ''}</strong>
                    <small>{job.errorDetails.filename || job.errorDetails.fileId} · GOG {job.errorDetails.productId}{job.errorDetails.errorCode ? ` · ${job.errorDetails.errorCode}` : ''}</small>
                    <span>{job.errorDetails.retryable ? 'Resume retries this part; completed parts are kept.' : 'Review this failure before retrying.'}</span>
                  </div>}
                  <div className="queue-progress">
                    <span
                      style={{
                        width: `${job.total ? Math.min(100, (job.bytes / job.total) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="queue-data">
                    <strong>
                      {job.total
                        ? Math.floor((job.bytes / job.total) * 100)
                        : 0}
                      %
                    </strong>
                    <span>
                      {fmt(job.bytes)} / {fmt(job.total)}
                    </span>
                  </div>
                  <div className="queue-data">
                    <span>{fmt(job.speed)}/s</span>
                    <span>
                      {job.speed && job.total > job.bytes
                        ? `${Math.ceil((job.total - job.bytes) / job.speed / 60)} min left`
                        : "—"}
                    </span>
                  </div>
                  <div className="queue-buttons">
                    {["downloading", "queued", "verifying"].includes(
                      job.state,
                    ) ? (
                      <button
                        title="Pause"
                        onClick={() =>
                          void notify(() =>
                            api(`/queue/${job.id}/pause`, "POST"),
                          )
                        }
                      >
                        <Pause size={16} />
                      </button>
                    ) : ["paused", "error"].includes(job.state) ? (
                      <button
                        title="Resume"
                        onClick={() =>
                          void notify(() =>
                            api(`/queue/${job.id}/resume`, "POST"),
                          )
                        }
                      >
                        <Play size={16} />
                      </button>
                    ) : null}
                    {!["complete", "cancelled"].includes(job.state) && (
                      <button
                        title="Cancel"
                        onClick={() =>
                          void notify(() =>
                            api(`/queue/${job.id}/cancel`, "POST"),
                          )
                        }
                      >
                        <Square size={16} />
                      </button>
                    )}
                    {["complete", "cancelled", "error"].includes(job.state) && (
                      <button
                        title="Remove"
                        onClick={() =>
                          void notify(() =>
                            api(`/queue/${job.id}/remove`, "POST"),
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="queue-empty">
              <Download size={30} />
              <h3>Queue is clear</h3>
              <p>Choose files from a game to start archiving.</p>
            </div>
          )}
        </div>
      </aside>
      {detail && (
        <GameModal
          detail={detail}
          defaults={settings}
          vaultPath={settings?.vaultPath || "No vault selected"}
          busy={!!busy}
          close={() => setDetail(null)}
          update={updateDetail}
          onArchiveMedia={() => void notify(async () => {
            await api(`/games/${detail.game.id}/media/archive`, "POST");
            await openGame(detail.game.id);
          }, "Archiving media")}
          onLinkFolder={() => void pickVault().then(folder => { if (folder) return linkFolder(detail.game.id, folder); }).catch(cause => setError((cause as Error).message))}
          queue={jobs.find(
            (job) =>
              job.gameId === detail.game.id &&
              ["queued", "downloading", "verifying", "paused"].includes(
                job.state,
              ),
          )}
          onQueue={(action) =>
            void notify(() =>
              api(`/queue/${action.id}/${action.command}`, "POST"),
            )
          }
        />
      )}
    </div>
  );
}

function GameModal({
  detail,
  defaults: defaultSettings,
  vaultPath,
  close,
  update,
  onArchiveMedia,
  onLinkFolder,
  busy,
  queue,
  onQueue,
}: {
  detail: Detail;
  defaults: Settings | null;
  vaultPath: string;
  close: () => void;
  update: (path: string, method?: string, body?: unknown) => void;
  onArchiveMedia: () => void;
  onLinkFolder: () => void;
  busy: boolean;
  queue?: Job;
  onQueue: (action: { id: number; command: string }) => void;
}) {
  const { game, files, media } = detail;
  const [platform, setPlatform] = useState("All systems");
  const [language, setLanguage] = useState("All languages");
  const [chosenPlatforms, setChosenPlatforms] = useState<Platform[]>(defaultSettings?.platforms || ['windows']);
  const [chosenLanguages, setChosenLanguages] = useState<string[]>(defaultSettings?.languages || ['English']);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [activeMedia, setActiveMedia] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [localSources, setLocalSources] = useState<Record<string, string>>({});
  const gallery = uniqueMedia(media);
  const imageCount = gallery.filter(asset => asset.role !== 'video').length;
  const videoCount = gallery.filter(asset => asset.role === 'video').length;
  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    for (const asset of [...gallery, ...media.filter(item => item.role === 'videoPoster')]) {
      const kind = { hero: 'background', card: 'cover', logo: 'logo', icon: 'icon', videoPoster: 'videoPoster' } as const;
      const load = asset.localPath ? asset.role === 'video' ? streamedMedia(game.id, asset.key) : localMedia(game.id, asset.key)
        : asset.role in kind ? localArtwork(game.id, kind[asset.role as keyof typeof kind])
          : null;
      if (load) void load.then(url => {
        if (!asset.localPath || asset.role !== 'video') objectUrls.push(url);
        if (active) setLocalSources(old => ({ ...old, [asset.key]: url }));
        else URL.revokeObjectURL(url);
      }).catch(() => {});
    }
    return () => { active = false; objectUrls.forEach(url => URL.revokeObjectURL(url)); setLocalSources({}); };
  }, [game.id, media]);
  useEffect(() => { setMediaOpen(false); setPreviewOpen(false); setActiveMedia(0); }, [game.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (previewOpen) setPreviewOpen(false); else close(); }
      if (previewOpen && event.key === "ArrowLeft") setActiveMedia(index => (index - 1 + gallery.length) % gallery.length);
      if (previewOpen && event.key === "ArrowRight") setActiveMedia(index => (index + 1) % gallery.length);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close, previewOpen, gallery.length]);
  const patchSelection = (key: string, selected: boolean) =>
    update(`/games/${game.id}/selections`, "PATCH", {
      files: [{ key, selected }],
    });
  const matchesSelection = (file: RemoteFile, platforms: Platform[], languages: string[]) =>
    platforms.includes(file.platform) && (file.language === 'Neutral' || languages.some(value => value.toLowerCase() === file.language.toLowerCase())) &&
      (file.category === 'main' || file.category === 'dlc' && !!defaultSettings?.dlc || file.category === 'extras' && !!defaultSettings?.extras || file.category === 'patches' && !!defaultSettings?.patches || file.category === 'languagePacks' && !!defaultSettings?.languagePacks)
  const applySelection = (platforms: Platform[], languages: string[]) => update(`/games/${game.id}/selections`, 'PATCH', { files: files.map(file => ({ key: file.key, selected: matchesSelection(file, platforms, languages) })) });
  const shown = files.filter(
    (file) =>
      (platform === "All systems" || file.platform === platform) &&
      (language === "All languages" || file.language === language),
  );
  const groups: [Category, string][] = [
    ["main", "MAIN / OFFLINE INSTALLERS"],
    ["dlc", "DLC"],
    ["extras", "EXTRAS"],
    ["patches", "PATCHES"],
    ["languagePacks", "LANGUAGE PACKS"],
    ["other", "OTHER CONTENT"],
  ];
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${game.title} details`}
      >
        <div className="detail-hero">
          <Artwork game={game} type="background" />
          <div className="detail-hero-fade" />
          <button
            className="modal-close icon-button"
            title="Close details"
            onClick={close}
          >
            <X size={20} />
          </button>
          <div className="detail-identity">
            <div className="detail-cover">
              <Artwork game={game} />
            </div>
            <div>
              <div className="eyebrow">PRODUCT / {game.id}</div>
              <h2>{game.title}</h2>
              <div className="identity-meta">
                <span
                  className={`status ${game.status.toLowerCase().replaceAll(" ", "-")}`}
                >
                  {game.status}
                </span>
                <Platforms platforms={game.platforms} />
                {game.releaseDate && (
                  <span>{game.releaseDate.slice(0, 10)}</span>
                )}
              </div>
            </div>
          </div>
        </div>
        {gallery.length > 0 && (
          <section className="media-section" aria-label="Game media">
            <button className="media-toggle" aria-expanded={mediaOpen} onClick={() => setMediaOpen(!mediaOpen)}>
              <span>MEDIA <small>{imageCount} IMAGES · {videoCount} VIDEOS</small></span>
              <span className="media-peek">{gallery.filter(asset => asset.role === 'screenshot' || asset.role === 'video').slice(0, 3).map(asset => {
                const poster = media.find(item => item.role === 'videoPoster' && item.url === asset.poster);
                return <img key={asset.key} src={asset.role === 'video' ? poster && localSources[poster.key] || asset.poster : localSources[asset.key] || asset.url} alt="" />;
              })}</span>
              <ChevronDown size={17} className={mediaOpen ? 'media-chevron-open' : ''} />
            </button>
            {mediaOpen && (
              <div className="media-rail">
                {gallery.map((asset, index) => (
                  <button key={asset.key} className={`media-thumb ${asset.roles.length === 1 && asset.role === 'icon' ? 'media-icon' : ''}`} title={asset.role === 'video' ? 'Play video' : `View ${asset.roles.join(', ')}`} onClick={() => { setActiveMedia(index); setPreviewOpen(true); }}>
                    {asset.role === 'video' ? (() => {
                      const poster = media.find(item => item.role === 'videoPoster' && item.url === asset.poster);
                      return asset.poster ? <img src={poster && localSources[poster.key] || asset.poster} alt="Video poster" loading="lazy" /> : null;
                    })() : <img src={localSources[asset.key] || asset.url} alt={asset.roles.join(', ')} loading="lazy" style={asset.role === 'icon' ? { width: Math.min(asset.width || 64, 88), height: Math.min(asset.height || 64, 52) } : undefined} />}
                    {asset.role === 'video' && <Play size={24} fill="currentColor" className="media-play" />}
                    <small>{asset.roles.map(role => role.toUpperCase()).join(' · ')}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        <div className="detail-content">
          <div className="detail-toolbar">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => update(`/games/${game.id}/downloads`)}
            >
              <RefreshCw size={16} />
              Refresh metadata
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => update(`/games/${game.id}/scan`)}
            >
              <Search size={16} />
              Scan Directory
            </button>
            <button
              className="secondary-button"
              disabled={busy || !game.folder}
              onClick={() => update(`/games/${game.id}/verify`)}
            >
              <ShieldCheck size={16} />
              Full Verify
            </button>
            {queue ? (
              <>
                <button
                  className="primary-button"
                  onClick={() =>
                    onQueue({
                      id: queue.id,
                      command: queue.state === "paused" ? "resume" : "pause",
                    })
                  }
                >
                  {queue.state === "paused" ? (
                    <Play size={16} />
                  ) : (
                    <Pause size={16} />
                  )}
                  {queue.state === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => onQueue({ id: queue.id, command: "cancel" })}
                >
                  <X size={16} />
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="primary-button"
                disabled={
                  !files.some((file) => file.selected && !file.verified && !file.matched) || busy
                }
                onClick={() => update(`/games/${game.id}/queue`)}
              >
                <Download size={16} />
                {game.status === "Update Available"
                  ? "Update selected"
                  : "Download selected"}
              </button>
            )}
          </div>
          <div className="detail-summary">
            <div className="detail-meters">
              <Meter label="MAIN" value={game.completion.main} />
              <Meter label="DLC" value={game.completion.dlc} />
              <Meter label="EXTRAS" value={game.completion.extras} />
            </div>
            {game.folder && (
              <p className="field-help">
                {files.filter(file => file.selected && file.verified).length} checksum verified · {files.filter(file => file.selected && file.matched && !file.verified).length} identified by filename and size · {files.filter(file => file.selected && !file.verified && !file.matched).length} missing.
                {game.status === "Needs Verification" && " Full verify requires checksum metadata from GOG."}
              </p>
            )}
            <div className="detail-facts">
              <div>
                <span>LOCAL FOLDER</span>
                <strong>
                  {game.folder ? `${vaultPath}/${game.folder}` : "Not linked"}
                </strong>
              </div>
              <div>
                <span>LOCAL / REMOTE</span>
                <strong>
                  {fmt(game.localSize)} / {fmt(game.remoteSize)}
                </strong>
              </div>
              <div>
                <span>LAST REFRESH</span>
                <strong>
                  {game.refreshedAt
                    ? new Date(game.refreshedAt).toLocaleString()
                    : "Never"}
                </strong>
              </div>
              <div>
                <span>LAST SCAN</span>
                <strong>
                  {game.scannedAt
                    ? new Date(game.scannedAt).toLocaleString()
                    : "Never"}
                </strong>
              </div>
            </div>
          </div>
          {!game.folder && (
            <div className="link-folder">
              <span>Have an existing archive? Link its folder:</span>
              <button
                className="secondary-button"
                onClick={onLinkFolder}
              >
                <HardDrive size={15} />
                Choose game folder
              </button>
            </div>
          )}
          <div className="file-heading">
            <div>
              <div className="eyebrow">OFFLINE ARCHIVE / FILE MANIFEST</div>
              <h3>Download content</h3>
              <p>
                Select the exact installers and extras to retain. Alternate
                systems and versions remain visible.
              </p>
            </div>
            <button
              className="text-button"
              onClick={() => update(`/games/${game.id}/downloads`)}
            >
              <RefreshCw size={15} />
              Query GOG
            </button>
          </div>
          <div className="file-filters">
            <select
              aria-label="Filter file system"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
            >
              <option>All systems</option>
              <option value="windows">Windows</option>
              <option value="linux">Linux</option>
              <option value="mac">macOS</option>
            </select>
            <select
              aria-label="Filter file language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option>All languages</option>
              {[...new Set(files.map((file) => file.language))].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </div>
          <div className="selection-quick"><div><strong>PLATFORMS</strong>{(['windows', 'linux', 'mac'] as Platform[]).map(value => <label key={value}><input type="checkbox" checked={chosenPlatforms.includes(value)} onChange={() => setChosenPlatforms(old => old.includes(value) ? old.filter(item => item !== value) : [...old, value])} />{value === 'mac' ? 'macOS' : value}</label>)}</div><div><strong>LANGUAGES</strong>{[...new Set(files.map(file => file.language).filter(value => value !== 'Neutral'))].map(value => <label key={value}><input type="checkbox" checked={chosenLanguages.some(item => item.toLowerCase() === value.toLowerCase())} onChange={() => setChosenLanguages(old => old.includes(value) ? old.filter(item => item !== value) : [...old, value])} />{value}</label>)}</div><div className="selection-actions"><small>{files.filter(file => matchesSelection(file, chosenPlatforms, chosenLanguages)).length} matching files</small><button className="secondary-button" disabled={busy} onClick={() => applySelection(chosenPlatforms, chosenLanguages)}>Select matching</button><button className="secondary-button" disabled={busy} onClick={() => update(`/games/${game.id}/selections`, 'PATCH', { files: files.map(file => ({ key: file.key, selected: false })) })}>Clear selection</button><button className="secondary-button" disabled={busy} onClick={() => { const platforms = defaultSettings?.platforms || ['windows']; const languages = defaultSettings?.languages || ['English']; setChosenPlatforms(platforms); setChosenLanguages(languages); applySelection(platforms, languages); }}>Reset to defaults</button></div></div>
          {groups.map(([category, label]) => (
            <section className="file-group" key={category}>
              <h4>
                {label}
                <span>
                  {shown.filter((file) => file.category === category).length}
                </span>
              </h4>
              {shown
                .filter((file) => file.category === category)
                .map((file) => (
                  <label className="file-row" key={file.key}>
                    <input
                      type="checkbox"
                      checked={file.selected}
                      onChange={(event) =>
                        patchSelection(file.key, event.target.checked)
                      }
                    />
                    <span className="file-os">
                      <Platforms platforms={[file.platform]} />
                    </span>
                    <span className="file-description">
                      <strong>{file.name}</strong>
                      <small>
                        {file.dlc && `${file.dlc} · `}
                        {file.platform === "mac"
                          ? "macOS"
                          : file.platform} · {file.language}
                        {file.version && ` · Version ${file.version}`}
                        {file.verified ? file.verificationSource === 'local-sha256' ? ' · Local SHA-256 verified (GOG checksum unavailable)' : ' · GOG checksum verified' : file.matched ? " · Matched by name and size" : game.folder ? " · Missing" : ""}
                      </small>
                    </span>
                    <span className="file-size">{fmt(file.verifiedSize || file.size)}</span>
                  </label>
                ))}
              {!shown.some((file) => file.category === category) && (
                <div className="no-files">
                  No files available in this category.
                </div>
              )}
            </section>
          ))}
          {(imageCount > 0 || videoCount > 0) && (
            <section className="file-group">
              <h4>STORE MEDIA <span>{imageCount} images · {videoCount} videos</span></h4>
              {media.filter(asset => asset.role === 'screenshot' || asset.role === 'additionalArtwork' || asset.role === 'video').map(asset => (
                <label className="file-row" key={asset.key}>
                  <input type="checkbox" disabled={asset.external || busy} checked={asset.selected} onChange={event => update(`/games/${game.id}/media`, 'PATCH', { files: [{ key: asset.key, selected: event.target.checked }] })} />
                  <span className="file-description"><strong>{asset.role === 'video' ? 'Store video' : 'Store image'}</strong><small>{asset.external ? 'External video · open only' : asset.localPath ? 'Archived offline' : 'Viewable online · not archived'}</small></span>
                  <span className="file-size">{asset.size ? fmt(asset.size) : 'Size unknown'}</span>
                </label>
              ))}
              {media.some(asset => asset.selected && !asset.localPath && !asset.external) && <button className="secondary-button" disabled={busy || !game.folder} onClick={onArchiveMedia}><Download size={15} /> Archive selected media</button>}
            </section>
          )}
        </div>
        {previewOpen && gallery[activeMedia] && (
          <div className="media-lightbox" role="dialog" aria-modal="true" aria-label="Media preview" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
            <button className="icon-button media-lightbox-close" title="Close preview" onClick={() => setPreviewOpen(false)}><X size={22} /></button>
            <button className="icon-button media-previous" title="Previous media" onClick={() => setActiveMedia((activeMedia - 1 + gallery.length) % gallery.length)}><ChevronLeft size={25} /></button>
            {gallery[activeMedia]!.role === 'video' ? gallery[activeMedia]!.external ? gallery[activeMedia]!.embedUrl && /^(https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}|https:\/\/player\.vimeo\.com\/video\/\d+)$/.test(gallery[activeMedia]!.embedUrl!) ? (
              <iframe key={gallery[activeMedia]!.key} className="media-embed" src={gallery[activeMedia]!.embedUrl} title={gallery[activeMedia]!.title || 'Video'} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="no-referrer" />
            ) : (
              <div className="media-lightbox-video">{gallery[activeMedia]!.poster && <img src={gallery[activeMedia]!.poster} alt="Video poster" />}{gallery[activeMedia]!.title && <strong>{gallery[activeMedia]!.title}</strong>}<button className="primary-button" onClick={() => void openUrl(gallery[activeMedia]!.url)}>Open video <Play size={16} /></button></div>
            ) : (
              <video key={gallery[activeMedia]!.key} controls autoPlay preload="metadata" poster={gallery[activeMedia]!.poster} src={playableVideoSource(gallery[activeMedia]!, localSources[gallery[activeMedia]!.key]) || undefined} />
            ) : (
              <img src={localSources[gallery[activeMedia]!.key] || gallery[activeMedia]!.url} alt={gallery[activeMedia]!.role} />
            )}
            <button className="icon-button media-next" title="Next media" onClick={() => setActiveMedia((activeMedia + 1) % gallery.length)}><ChevronRight size={25} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
