import './DiffView.css';

export interface DiffLineView {
  type: 'context' | 'add' | 'remove';
  content: string;
}

export interface DiffHunkView {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLineView[];
}

export interface FileDiffView {
  path: string;
  status: string;
  oldPath?: string;
  hunks: DiffHunkView[];
  isBinary: boolean;
}

interface DiffViewProps {
  diffs: FileDiffView[];
  title?: string;
}

export function DiffView({ diffs, title }: DiffViewProps) {
  if (diffs.length === 0) {
    return <div className="diff-empty">No changes</div>;
  }

  return (
    <div className="diff-view">
      {title && <div className="diff-title">{title}</div>}
      {diffs.map((file, fi) => (
        <div key={fi} className="diff-file">
          <div className="diff-file-header">
            <span className={`diff-status diff-status-${file.status}`}>
              {statusLabel(file.status)}
            </span>
            <span className="diff-file-path">{file.path}</span>
            {file.oldPath && (
              <span className="diff-file-rename"> ← {file.oldPath}</span>
            )}
          </div>
          {file.isBinary ? (
            <div className="diff-binary">Binary file</div>
          ) : (
            file.hunks.map((hunk, hi) => (
              <div key={hi} className="diff-hunk">
                <div className="diff-hunk-header">
                  @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                  {hunk.header && <span className="diff-hunk-ctx"> {hunk.header}</span>}
                </div>
                <div className="diff-lines">
                  {hunk.lines.map((line, li) => {
                    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                    return (
                      <div key={li} className={`diff-line diff-line-${line.type}`}>
                        <span className="diff-line-prefix">{prefix}</span>
                        <span className="diff-line-content">{line.content}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'added': return 'A';
    case 'modified': return 'M';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    default: return '?';
  }
}
