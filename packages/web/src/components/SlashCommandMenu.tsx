import { useEffect, useRef } from 'react';
import './SlashCommandMenu.css';

export interface SlashCommand {
  command: string;
  description: string;
  source: 'builtin' | 'skill';
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.toLowerCase();
  if (!normalized) {
    return commands;
  }

  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];

  for (const cmd of commands) {
    if (cmd.command.startsWith(normalized)) {
      prefix.push(cmd);
    } else if (
      cmd.command.includes(normalized) ||
      cmd.description.toLowerCase().includes(normalized)
    ) {
      contains.push(cmd);
    }
  }

  return [...prefix, ...contains];
}

export function useSlashCommandFilter(
  commands: SlashCommand[],
  query: string
): SlashCommand[] {
  return filterCommands(commands, query);
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="slash-command-menu" ref={listRef}>
      {commands.map((cmd, index) => (
        <button
          key={cmd.command}
          type="button"
          className={`slash-command-item${index === selectedIndex ? ' slash-command-item-active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
        >
          <span className="slash-command-name">/{cmd.command}</span>
          <span className="slash-command-desc">{cmd.description}</span>
          {cmd.source === 'skill' && (
            <span className="slash-command-badge">skill</span>
          )}
        </button>
      ))}
    </div>
  );
}
