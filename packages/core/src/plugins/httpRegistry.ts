import type { PluginHttpMethod, PluginHttpRouteDefinition } from './types.js';

export class PluginHttpRegistry {
  private readonly routesByPlugin = new Map<string, PluginHttpRouteDefinition[]>();

  replacePlugin(pluginId: string, routes: PluginHttpRouteDefinition[]): void {
    this.routesByPlugin.set(pluginId, routes.map((route) => ({ ...route })));
  }

  removePlugin(pluginId: string): void {
    this.routesByPlugin.delete(pluginId);
  }

  resolve(
    pluginId: string,
    method: string,
    subPath: string
  ): PluginHttpRouteDefinition | undefined {
    const normalizedMethod = method.toUpperCase() as PluginHttpMethod;
    const normalizedPath = normalizeRoutePath(subPath);
    const routes = this.routesByPlugin.get(pluginId) ?? [];
    return routes.find((route) => (
      route.method === normalizedMethod && normalizeRoutePath(route.path) === normalizedPath
    ));
  }

  countRoutes(pluginId: string): number {
    return (this.routesByPlugin.get(pluginId) ?? []).length;
  }
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/g, '');
  return trimmed || '';
}
