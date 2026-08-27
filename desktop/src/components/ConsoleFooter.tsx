export type PackProgress = {
  slug?: string;
  stage: string;
  current: number;
  total: number;
  percent: number;
  message: string;
};

type Props = {
  log: string;
  progress: PackProgress | null;
  busy: boolean;
};

export default function ConsoleFooter({ log, progress, busy }: Props) {
  const percent = progress?.total ? progress.percent : busy ? 8 : 0;
  const label = progress?.message || (busy ? "Working…" : "");

  return (
    <footer className="console-footer">
      {(busy || progress) && (
        <div className="progress">
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <p className="muted">
            {label}
            {progress && progress.total > 0 ? ` (${progress.current}/${progress.total})` : ""}
          </p>
        </div>
      )}
      <pre className="log">{log || "Ready."}</pre>
    </footer>
  );
}
