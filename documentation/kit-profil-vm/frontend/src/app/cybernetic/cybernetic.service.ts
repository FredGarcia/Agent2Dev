import { Injectable, signal, NgZone } from '@angular/core';

export interface Cycle7E {
  id: string;
  cycle_number: number;
  rank: string;
  status: 'HEALTHY' | 'DEGRADED' | 'ADAPTING';
  state_data: Record<string, unknown>;
  metrics: {
    total: number;
    running: number;
    restarts: number;
    timestamp: string;
  };
  action_taken: {
    type: string;
    rule?: string;
  } | null;
  created_at: string;
}

@Injectable({
  providedIn: 'root'
})
export class CyberneticService {
  readonly currentCycle = signal<Cycle7E | null>(null);
  readonly cycleHistory = signal<Cycle7E[]>([]);
  readonly isConnected = signal<boolean>(false);

  private eventSource!: EventSource;

  constructor(private zone: NgZone) {
    this.connectToStream();
    this.loadInitialHistory();
  }

  private async loadInitialHistory(): Promise<void> {
    try {
      const res = await fetch('/api/7e/history');
      if (res.ok) {
        const history: Cycle7E[] = await res.json();
        this.zone.run(() => {
          this.cycleHistory.set(history);
          if (history.length > 0) {
            this.currentCycle.set(history[0]);
          }
        });
      }
    } catch (err) {
      console.error('[CYBERNETIC SERVICE] Échec chargement historique :', err);
    }
  }

  private connectToStream(): void {
    this.eventSource = new EventSource('/api/7e/stream');

    this.eventSource.onopen = () => {
      this.zone.run(() => this.isConnected.set(true));
    };

    this.eventSource.addEventListener('cycle_update', (event: MessageEvent) => {
      const newCycle: Cycle7E = JSON.parse(event.data);
      this.zone.run(() => {
        this.currentCycle.set(newCycle);
        this.cycleHistory.update(history => [
          newCycle,
          ...history.filter(h => h.id !== newCycle.id).slice(0, 19)
        ]);
      });
    });

    this.eventSource.onerror = () => {
      this.zone.run(() => this.isConnected.set(false));
    };
  }
}