import type { ActivePlan, BaseAdvice, TargetCheck } from '../../core/target/planner';

export interface SettingsView {
  tolerancePct: number;
  league: string;
  pricesFetchedAt: number | null;
  priceRows: Array<{ id: string; label: string; price: number | null; manual: number | null }>;
  targets: Array<{ id: string; name: string; baseType: string; mods: string[]; basePrice: number | null }>;
}

declare global {
  interface Window {
    craft: {
      readClipboard(): Promise<string>;
      writeClipboard(text: string): Promise<void>;
      hideOverlay(): void;
      quitApp(): void;
      moveOverlay(dx: number, dy: number): void;
      getSettings(): Promise<SettingsView>;
      updateSettings(patch: Record<string, unknown>): Promise<SettingsView>;
      addTarget(text: string): Promise<SettingsView | { error: string }>;
      removeTarget(id: string): Promise<SettingsView>;
      setBasePrice(id: string, price: number | null): Promise<SettingsView>;
      getBases(id: string): Promise<BaseAdvice | null>;
      refreshPrices(): Promise<{ error?: string; view: SettingsView }>;
      getPlan(): Promise<ActivePlan | null>;
      savePlan(plan: ActivePlan | null): Promise<void>;
      onTargetResult(callback: (check: TargetCheck) => void): () => void;
      onCapture(callback: (text: string | null) => void): () => void;
    };
  }
}
