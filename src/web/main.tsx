import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
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
import type {
  Game,
  Job,
  RemoteFile,
  Settings,
  Platform,
  Category,
} from "../shared/domain";
import "./style.css";

type Page = "dashboard" | "library" | "settings";
type Detail = { game: Game; files: RemoteFile[] };
type Account = { connected: boolean; username: string; loginUrl: string };
type Storage = {
  path: string;
  dirs: string[];
  writable: boolean;
  free: number;
  total: number;
};
type Dashboard = {
  counts: Record<string, number>;
  activity: { at: string; message: string }[];
};
const fmt = (bytes: number) =>
  bytes
    ? `${(bytes / 1024 ** (bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : 1)).toFixed(1)} ${bytes >= 1024 ** 3 ? "GB" : bytes >= 1024 ** 2 ? "MB" : "KB"}`
    : "0 B";
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
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
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
  type?: "cover" | "background";
}) {
  const [fallback, setFallback] = useState(false);
  const remote = type === "cover" ? game.cover : game.background;
  const source =
    game.folder && !fallback ? `/api/art/${game.id}/${type}` : remote;
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
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [os, setOs] = useState("All systems");
  const [sort, setSort] = useState("Title A-Z");
  const [columnSort, setColumnSort] = useState<{ label: string; descending: boolean } | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [code, setCode] = useState("");

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
    let socket: WebSocket;
    let reconnect: ReturnType<typeof setTimeout>;
    function connect() {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/queue`,
      );
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "queue") {
            setJobs(message.jobs);
            void api<Game[]>("/games").then(setGames);
          }
        } catch {}
      };
      socket.onclose = () => {
        reconnect = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      clearInterval(timer);
      clearTimeout(reconnect);
      socket.onclose = null;
      socket.close();
    };
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
  const showStorage = async (path: string) => {
    try {
      setStorage(
        await api<Storage>(`/storage?path=${encodeURIComponent(path)}`),
      );
      setStoragePath(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };
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
          <span className="brand-mark">
            G<span>V</span>
          </span>
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
          <span className="breadcrumb">
            SYSTEM <ChevronRight size={13} /> <b>{page.toUpperCase()}</b>
          </span>
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
              <div className="page-heading">
                <div className="eyebrow">
                  OVERVIEW // YOUR OFFLINE COLLECTION
                </div>
                <h1>
                  Command center<span className="accent">.</span>
                </h1>
                <p>Every game you own. Every installer you keep.</p>
              </div>
              <section className="hero-panel">
                <div className="hero-copy">
                  <span className="eyebrow">VAULT STATUS / LIVE</span>
                  <h2>
                    {account?.connected
                      ? "Your library, under your control."
                      : "Your archive starts here."}
                  </h2>
                  <p>
                    {account?.connected
                      ? "Keep your owned games safe, verified and ready to install offline."
                      : "Connect your GOG account to inventory owned games and start building your offline vault."}
                  </p>
                  <button
                    className="primary-button"
                    onClick={() =>
                      nav(account?.connected ? "library" : "settings")
                    }
                  >
                    {account?.connected ? "Explore library" : "Connect GOG"}{" "}
                    <ArrowRight size={17} />
                  </button>
                </div>
                <div className="hero-signal">
                  <span>GOG / VAULT</span>
                  <strong>
                    {String(dashboard?.counts.owned || 0).padStart(3, "0")}
                  </strong>
                  <small>OWNED TITLES INDEXED</small>
                </div>
              </section>
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
                  <small>{fmt(dashboard?.counts.free || 0)} AVAILABLE</small>
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
                <div>
                  <div className="eyebrow">
                    COLLECTION // {games.length} OWNED TITLES
                  </div>
                  <h1>
                    Game library<span className="accent">.</span>
                  </h1>
                  <p>Discover what is ready for offline play.</p>
                </div>
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
                              {game.title}
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
                          <Artwork game={game} />
                          {game.status === "Update Available" && (
                            <span className="update-tag">UPDATE</span>
                          )}
                        </div>
                        <div className="game-info">
                          <h3>{game.title}</h3>
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
              <div className="page-heading">
                <div className="eyebrow">CONFIGURATION // CONTROL PANEL</div>
                <h1>
                  Settings<span className="accent">.</span>
                </h1>
                <p>Configure your account, archive and downloads.</p>
              </div>
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
                      <button
                        className="primary-button"
                        onClick={() => {
                          if (account?.loginUrl)
                            window.open(
                              account.loginUrl,
                              "_blank",
                              "noopener,noreferrer",
                            );
                        }}
                      >
                        Connect GOG <ArrowRight size={16} />
                      </button>
                      <p className="field-help">
                        Sign in on GOG, then paste the resulting URL or
                        authorization code below. Your password never enters
                        this app.
                      </p>
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
                          disabled={!code || !!busy}
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
                      <p>Files are written on the server inside /vault.</p>
                    </div>
                  </div>
                  <div className="setting-line">
                    <span>Selected directory</span>
                    <strong>
                      /vault
                      {settings?.vaultPath ? `/${settings.vaultPath}` : ""}
                    </strong>
                  </div>
                  <div className="setting-line">
                    <span>Configuration</span>
                    <strong>/config</strong>
                  </div>
                  <div className="setting-line">
                    <span>Free space</span>
                    <strong>
                      {fmt(storage?.free || dashboard?.counts.free || 0)}
                    </strong>
                  </div>
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
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void showStorage(settings?.vaultPath || "")
                      }
                    >
                      <HardDrive size={16} />
                      Browse server folders
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
                      Scan vault
                    </button>
                  </div>
                  {scan.running && (
                    <p className="field-help">
                      Scanning {scan.done} / {scan.total} games...
                    </p>
                  )}
                  {scan.error && (
                    <p className="field-help error-text">{scan.error}</p>
                  )}
                  {storage && (
                    <div className="directory-browser">
                      <div className="browser-location">
                        <button
                          title="Parent folder"
                          onClick={() =>
                            void showStorage(
                              storagePath.split("/").slice(0, -1).join("/"),
                            )
                          }
                          disabled={!storagePath}
                        >
                          <ArrowLeft size={16} />
                        </button>
                        <span>/vault/{storagePath}</span>
                        <button
                          className="primary-button"
                          onClick={() =>
                            void notify(async () => {
                              setSettings(
                                await api<Settings>("/storage/select", "POST", {
                                  path: storagePath,
                                }),
                              );
                            }, "Selecting storage")
                          }
                        >
                          Use this folder
                        </button>
                      </div>
                      {storage.dirs.map((dir) => (
                        <button
                          className="directory"
                          key={dir}
                          onClick={() =>
                            void showStorage(
                              [storagePath, dir].filter(Boolean).join("/"),
                            )
                          }
                        >
                          <HardDrive size={15} />
                          {dir}
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <section className="settings-section">
                  <div className="section-title">
                    <Download size={21} />
                    <div>
                      <h2>Downloads</h2>
                      <p>
                        Choose the default copy to archive. Override files per
                        game.
                      </p>
                    </div>
                  </div>
                  {settings && (
                    <div className="settings-fields">
                      <label>
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
                        Preferred system
                        <select
                          value={settings.platform}
                          onChange={(event) =>
                            void changeSettings({
                              platform: event.target.value as Platform,
                            })
                          }
                        >
                          <option value="windows">Windows</option>
                          <option value="linux">Linux</option>
                          <option value="mac">macOS</option>
                        </select>
                      </label>
                      <label>
                        Preferred language
                        <input
                          value={settings.language}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              language: event.target.value,
                            })
                          }
                          onBlur={() =>
                            void changeSettings({ language: settings.language })
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
                      </label>
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
                    </div>
                  )}
                </section>
                <section className="settings-section">
                  <div className="section-title">
                    <SlidersHorizontal size={21} />
                    <div>
                      <h2>Library & appearance</h2>
                      <p>Metadata refresh and interface preferences.</p>
                    </div>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      disabled={!account?.connected}
                      onClick={() =>
                        void notify(
                          () => api("/gog/library", "POST"),
                          "Starting refresh",
                        )
                      }
                    >
                      <RefreshCw size={16} />
                      Refresh metadata
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void notify(
                          () => api("/storage/scan", "POST"),
                          "Starting scan",
                        )
                      }
                    >
                      <ShieldCheck size={16} />
                      Rescan files
                    </button>
                  </div>
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
                    {job.currentFile || job.error || "Waiting in queue"}
                  </p>
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
          busy={!!busy}
          close={() => setDetail(null)}
          update={updateDetail}
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
  close,
  update,
  busy,
  queue,
  onQueue,
}: {
  detail: Detail;
  close: () => void;
  update: (path: string, method?: string, body?: unknown) => void;
  busy: boolean;
  queue?: Job;
  onQueue: (action: { id: number; command: string }) => void;
}) {
  const { game, files } = detail;
  const [platform, setPlatform] = useState("All systems");
  const [language, setLanguage] = useState("All languages");
  const [folder, setFolder] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close]);
  const patchSelection = (key: string, selected: boolean) =>
    update(`/games/${game.id}/selections`, "PATCH", {
      files: [{ key, selected }],
    });
  const shown = files.filter(
    (file) =>
      (platform === "All systems" || file.platform === platform) &&
      (language === "All languages" || file.language === language),
  );
  const groups: [Category, string][] = [
    ["main", "MAIN / OFFLINE INSTALLERS"],
    ["dlc", "DLC"],
    ["extras", "EXTRAS"],
    ["other", "PATCHES / OTHER CONTENT"],
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
              Scan / Verify
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
                  !files.some((file) => file.selected && !file.verified) || busy
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
            <div className="detail-facts">
              <div>
                <span>LOCAL FOLDER</span>
                <strong>
                  {game.folder ? `/vault/${game.folder}` : "Not linked"}
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
              <select
                value={folder}
                onFocus={() =>
                  void api<Storage>("/storage").then((data) =>
                    setFolders(data.dirs),
                  )
                }
                onChange={(event) => setFolder(event.target.value)}
              >
                <option value="">Select a folder</option>
                {folders.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              <button
                className="secondary-button"
                disabled={!folder}
                onClick={() =>
                  update(`/games/${game.id}/link`, "POST", { folder })
                }
              >
                Link folder
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
                        {file.verified && " · Verified"}
                      </small>
                    </span>
                    <span className="file-size">{fmt(file.size)}</span>
                  </label>
                ))}
              {!shown.some((file) => file.category === category) && (
                <div className="no-files">
                  No files available in this category.
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
