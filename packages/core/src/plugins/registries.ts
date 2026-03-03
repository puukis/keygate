import type {
  PluginCliCommandDefinition,
  PluginHttpRouteDefinition,
  PluginRpcHandler,
} from './types.js';

interface OwnedCliCommand {
  pluginId: string;
  definition: PluginCliCommandDefinition;
}

export class PluginRegistries {
  private readonly rpcByPlugin = new Map<string, Map<string, PluginRpcHandler>>();
  private readonly httpByPlugin = new Map<string, PluginHttpRouteDefinition[]>();
  private readonly cliByPlugin = new Map<string, PluginCliCommandDefinition[]>();
  private readonly cliByName = new Map<string, OwnedCliCommand>();

  replacePlugin(
    pluginId: string,
    payload: {
      rpcMethods: Map<string, PluginRpcHandler>;
      httpRoutes: PluginHttpRouteDefinition[];
      cliCommands: PluginCliCommandDefinition[];
    }
  ): void {
    this.removePlugin(pluginId);

    this.rpcByPlugin.set(pluginId, new Map(payload.rpcMethods));
    this.httpByPlugin.set(pluginId, payload.httpRoutes.map((route) => ({ ...route })));
    this.cliByPlugin.set(pluginId, payload.cliCommands.map((command) => ({ ...command })));

    for (const command of payload.cliCommands) {
      this.cliByName.set(command.name, {
        pluginId,
        definition: command,
      });
    }
  }

  removePlugin(pluginId: string): void {
    this.rpcByPlugin.delete(pluginId);
    this.httpByPlugin.delete(pluginId);

    const commands = this.cliByPlugin.get(pluginId) ?? [];
    this.cliByPlugin.delete(pluginId);
    for (const command of commands) {
      const current = this.cliByName.get(command.name);
      if (current?.pluginId === pluginId) {
        this.cliByName.delete(command.name);
      }
    }
  }

  getRpcHandler(pluginId: string, method: string): PluginRpcHandler | undefined {
    return this.rpcByPlugin.get(pluginId)?.get(method);
  }

  getHttpRoutes(pluginId: string): PluginHttpRouteDefinition[] {
    return (this.httpByPlugin.get(pluginId) ?? []).map((route) => ({ ...route }));
  }

  getAllHttpRoutes(): Array<{ pluginId: string; routes: PluginHttpRouteDefinition[] }> {
    return Array.from(this.httpByPlugin.entries()).map(([pluginId, routes]) => ({
      pluginId,
      routes: routes.map((route) => ({ ...route })),
    }));
  }

  getCliCommand(commandName: string): { pluginId: string; definition: PluginCliCommandDefinition } | undefined {
    const record = this.cliByName.get(commandName);
    if (!record) {
      return undefined;
    }

    return {
      pluginId: record.pluginId,
      definition: { ...record.definition },
    };
  }
}
