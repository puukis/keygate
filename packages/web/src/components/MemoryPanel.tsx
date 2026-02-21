import { useState, useCallback } from 'react';
import './MemoryPanel.css';

export interface MemoryEntryView {
  id: number;
  namespace: string;
  key: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryPanelProps {
  connected: boolean;
  disabled: boolean;
  memories: MemoryEntryView[];
  namespaces: string[];
  onList: (namespace?: string) => void;
  onSearch: (query: string, namespace?: string) => void;
  onSet: (namespace: string, key: string, content: string) => void;
  onDelete: (namespace: string, key: string) => void;
  onLoadNamespaces: () => void;
}

export function MemoryPanel({
  connected,
  disabled,
  memories,
  namespaces,
  onList,
  onSearch,
  onSet,
  onDelete,
  onLoadNamespaces,
}: MemoryPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterNamespace, setFilterNamespace] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formNamespace, setFormNamespace] = useState('general');
  const [formKey, setFormKey] = useState('');
  const [formContent, setFormContent] = useState('');
  const [editingMemory, setEditingMemory] = useState<MemoryEntryView | null>(null);

  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      onSearch(searchQuery, filterNamespace || undefined);
    } else {
      onList(filterNamespace || undefined);
    }
  }, [searchQuery, filterNamespace, onSearch, onList]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  const handleSave = useCallback(() => {
    if (!formKey.trim() || !formContent.trim()) return;
    onSet(formNamespace, formKey.trim(), formContent.trim());
    setFormKey('');
    setFormContent('');
    setShowForm(false);
    setEditingMemory(null);
  }, [formNamespace, formKey, formContent, onSet]);

  const handleEdit = useCallback((memory: MemoryEntryView) => {
    setEditingMemory(memory);
    setFormNamespace(memory.namespace);
    setFormKey(memory.key);
    setFormContent(memory.content);
    setShowForm(true);
  }, []);

  const handleCancelForm = useCallback(() => {
    setShowForm(false);
    setEditingMemory(null);
    setFormKey('');
    setFormContent('');
    setFormNamespace('general');
  }, []);

  return (
    <>
      <div className="memory-controls">
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search memories..."
          spellCheck={false}
          autoComplete="off"
          disabled={!connected || disabled}
        />
        <select
          value={filterNamespace}
          onChange={(event) => setFilterNamespace(event.target.value)}
          disabled={!connected || disabled}
          onFocus={onLoadNamespaces}
        >
          <option value="">All namespaces</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>
        <button
          className="btn-secondary"
          onClick={handleSearch}
          disabled={!connected || disabled}
        >
          {searchQuery.trim() ? 'Search' : 'List'}
        </button>
        <button
          className="btn-secondary"
          onClick={() => {
            setShowForm(true);
            setEditingMemory(null);
            setFormNamespace('general');
            setFormKey('');
            setFormContent('');
          }}
          disabled={!connected || disabled}
        >
          + Add
        </button>
      </div>

      {showForm && (
        <div className="memory-form">
          <div className="memory-form-row">
            <input
              type="text"
              value={formNamespace}
              onChange={(event) => setFormNamespace(event.target.value)}
              placeholder="Namespace"
              spellCheck={false}
              disabled={!connected || disabled || editingMemory !== null}
            />
            <input
              type="text"
              value={formKey}
              onChange={(event) => setFormKey(event.target.value)}
              placeholder="Key"
              spellCheck={false}
              disabled={!connected || disabled || editingMemory !== null}
            />
          </div>
          <textarea
            value={formContent}
            onChange={(event) => setFormContent(event.target.value)}
            placeholder="Memory content..."
            disabled={!connected || disabled}
          />
          <div className="memory-form-actions">
            <button
              className="btn-secondary"
              onClick={handleCancelForm}
            >
              Cancel
            </button>
            <button
              className="btn-secondary"
              onClick={handleSave}
              disabled={!connected || disabled || !formKey.trim() || !formContent.trim()}
            >
              {editingMemory ? 'Update' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <p className="memory-count">{memories.length} memor{memories.length === 1 ? 'y' : 'ies'}</p>

      {memories.length > 0 ? (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={`${memory.namespace}/${memory.key}`} className="memory-item">
              <div className="memory-item-header">
                <span className="memory-item-key">{memory.key}</span>
                <span className="memory-item-ns">{memory.namespace}</span>
              </div>
              <div className="memory-item-content">
                {memory.content.length > 200
                  ? `${memory.content.slice(0, 197)}...`
                  : memory.content}
              </div>
              <div className="memory-item-actions">
                <button
                  className="btn-secondary"
                  onClick={() => handleEdit(memory)}
                  disabled={!connected || disabled}
                >
                  Edit
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => onDelete(memory.namespace, memory.key)}
                  disabled={!connected || disabled}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="memory-empty">
          No memories found. Click &quot;+ Add&quot; to create one, or &quot;List&quot; to load existing memories.
        </div>
      )}
    </>
  );
}
