import { useState, useCallback } from 'react';
import './MarketplacePanel.css';

export interface MarketplaceEntryView {
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  homepage?: string;
  tags: string[];
  downloads: number;
  featured: boolean;
}

interface MarketplacePanelProps {
  connected: boolean;
  disabled: boolean;
  searchResults: MarketplaceEntryView[];
  searchTotal: number;
  featuredEntries: MarketplaceEntryView[];
  selectedEntry: MarketplaceEntryView | null;
  installStatus: { name: string; success: boolean; message: string } | null;
  onSearch: (query: string, tags: string[]) => void;
  onSelectEntry: (name: string) => void;
  onClearSelection: () => void;
  onInstall: (name: string, scope: 'workspace' | 'global') => void;
  onLoadFeatured: () => void;
}

export function MarketplacePanel({
  connected,
  disabled,
  searchResults,
  searchTotal,
  featuredEntries,
  selectedEntry,
  installStatus,
  onSearch,
  onSelectEntry,
  onClearSelection,
  onInstall,
  onLoadFeatured,
}: MarketplacePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [installScope, setInstallScope] = useState<'workspace' | 'global'>('workspace');
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(() => {
    setHasSearched(true);
    onSearch(searchQuery, []);
  }, [searchQuery, onSearch]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  const displayEntries = hasSearched ? searchResults : featuredEntries;
  const showingFeatured = !hasSearched && featuredEntries.length > 0;

  return (
    <>
      <div className="marketplace-search-row">
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search skills..."
          spellCheck={false}
          autoComplete="off"
          disabled={!connected || disabled}
        />
        <button
          className="btn-secondary"
          onClick={handleSearch}
          disabled={!connected || disabled}
        >
          Search
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            setHasSearched(false);
            setSearchQuery('');
            onLoadFeatured();
          }}
          disabled={!connected || disabled}
        >
          Featured
        </button>
      </div>

      {selectedEntry ? (
        <div className="marketplace-detail">
          <div className="marketplace-detail-header">
            <h4>{selectedEntry.name}</h4>
            <button
              className="marketplace-detail-close"
              onClick={onClearSelection}
              aria-label="Close detail"
            >
              &times;
            </button>
          </div>
          <div className="marketplace-detail-body">
            <p>{selectedEntry.description}</p>
            <p>Author: {selectedEntry.author}</p>
            <p>Version: {selectedEntry.version}</p>
            <p>Downloads: {selectedEntry.downloads}</p>
            {selectedEntry.homepage && (
              <p>Homepage: {selectedEntry.homepage}</p>
            )}
            {selectedEntry.tags.length > 0 && (
              <div className="marketplace-tags">
                {selectedEntry.tags.map((tag) => (
                  <span key={tag} className="marketplace-tag">{tag}</span>
                ))}
              </div>
            )}
          </div>
          <div className="marketplace-detail-actions">
            <select
              value={installScope}
              onChange={(event) => setInstallScope(event.target.value as 'workspace' | 'global')}
              disabled={!connected || disabled}
            >
              <option value="workspace">Workspace</option>
              <option value="global">Global</option>
            </select>
            <button
              className="btn-secondary"
              onClick={() => onInstall(selectedEntry.name, installScope)}
              disabled={!connected || disabled}
            >
              Install
            </button>
          </div>
          {installStatus && installStatus.name === selectedEntry.name && (
            <p className={`marketplace-status ${installStatus.success ? 'marketplace-status-success' : 'marketplace-status-error'}`}>
              {installStatus.message}
            </p>
          )}
        </div>
      ) : (
        <>
          {showingFeatured && (
            <small className="config-note">Featured skills</small>
          )}
          {hasSearched && (
            <small className="config-note">
              {searchTotal} result{searchTotal !== 1 ? 's' : ''}
            </small>
          )}

          {displayEntries.length > 0 ? (
            <ul className="marketplace-results-list">
              {displayEntries.map((entry) => (
                <li
                  key={entry.name}
                  className="marketplace-result-item"
                  onClick={() => onSelectEntry(entry.name)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      onSelectEntry(entry.name);
                    }
                  }}
                >
                  <div className="marketplace-result-header">
                    <span className="marketplace-result-name">
                      {entry.featured && '★ '}
                      {entry.name}
                    </span>
                    <span className="marketplace-result-version">{entry.version}</span>
                  </div>
                  <div className="marketplace-result-desc">{entry.description}</div>
                  <div className="marketplace-result-meta">
                    <span>by {entry.author}</span>
                    <span>{entry.downloads} downloads</span>
                  </div>
                  {entry.tags.length > 0 && (
                    <div className="marketplace-tags">
                      {entry.tags.map((tag) => (
                        <span key={tag} className="marketplace-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="marketplace-empty">
              {hasSearched
                ? 'No skills found. Try a different query.'
                : 'Click "Featured" to browse popular skills, or search above.'}
            </div>
          )}
        </>
      )}
    </>
  );
}
