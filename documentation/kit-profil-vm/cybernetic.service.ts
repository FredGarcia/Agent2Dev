import { Injectable, signal, NgZone } from '@angular/core';

export interface Cycle7E {
    id: string;
    cycle_number: number;
    status: 'HEALTHY' | 'DEGRADED' | 'ADAPTING';
    state_data: any;
    metrics: any;
    action_taken: any;
    created_at: string;
}

@Injectable({
    providedIn: 'root'
})
export class CyberneticService {
    // Signals Angular réactifs
    readonly currentCycle = signal<Cycle7E | null>(null);
    readonly cycleHistory = signal<Cycle7E[]>([]);
    readonly isConnected = signal<boolean>(false);

    private eventSource!: EventSource;

    constructor(private zone: NgZone) {
        this.connectToStream();
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
                this.cycleHistory.update(history => [newCycle, ...history.slice(0, 19)]);
            });
        });

        this.eventSource.onerror = () => {
            this.zone.run(() => this.isConnected.set(false));
        };
    }
}