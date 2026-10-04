import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CyberneticService } from './cybernetic.service';

@Component({
  selector: 'app-cybernetic-dashboard',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="dashboard-container">
      <header class="header">
        <h1>GitManager — Cortex Visuel & Cybernétique 7E</h1>
        <div class="status-indicator" [class.online]="cyberService.isConnected()">
          <span class="dot"></span>
          {{ cyberService.isConnected() ? 'Flux SSE Actif' : 'Hors Ligne' }}
        </div>
      </header>

      <main>
        @if (cyberService.currentCycle(); as current) {
          <section class="card current-card">
            <h2>État courant 7E (Cycle #{{ current.cycle_number }})</h2>
            <div class="grid">
              <div class="metric">
                <span class="label">Statut système</span>
                <span class="value status-badge" [class]="current.status">{{ current.status }}</span>
              </div>
              <div class="metric">
                <span class="label">Conteneurs en exécution</span>
                <span class="value">{{ current.metrics.running }} / {{ current.metrics.total }}</span>
              </div>
              <div class="metric">
                <span class="label">Redémarrages réseau</span>
                <span class="value">{{ current.metrics.restarts }}</span>
              </div>
            </div>

            @if (current.action_taken) {
              <div class="action-banner">
                <strong>Régulation active :</strong> {{ current.action_taken.type }}
                <span *ngIf="current.action_taken.rule"> (Règle : {{ current.action_taken.rule }})</span>
              </div>
            }
          </section>
        }

        <section class="card history-card">
          <h2>Historique des transitions (PostgreSQL)</h2>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th scope="col">Cycle</th>
                  <th scope="col">Horodatage</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Disponibilité</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                @for (cycle of cyberService.cycleHistory(); track cycle.id) {
                  <tr>
                    <td>#{{ cycle.cycle_number }}</td>
                    <td>{{ cycle.created_at | date:'HH:mm:ss' }}</td>
                    <td><span class="status-badge" [class]="cycle.status">{{ cycle.status }}</span></td>
                    <td>{{ cycle.metrics.running }}/{{ cycle.metrics.total }}</td>
                    <td>{{ cycle.action_taken ? cycle.action_taken.type : '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  `,
  styles: [`
    .dashboard-container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 2px solid #000091; padding-bottom: 1rem; }
    .status-indicator { display: flex; align-items: center; gap: 0.5rem; font-weight: bold; color: #ce0500; }
    .status-indicator.online { color: #18753c; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background-color: currentColor; }
    .card { background: #ffffff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .metric { display: flex; flex-direction: column; }
    .label { font-size: 0.875rem; color: #666; }
    .value { font-size: 1.25rem; font-weight: bold; margin-top: 0.25rem; }
    .status-badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.875rem; font-weight: bold; }
    .status-badge.HEALTHY { background: #e6f8ef; color: #18753c; }
    .status-badge.DEGRADED { background: #fbe7e8; color: #ce0500; }
    .status-badge.ADAPTING { background: #fff3cd; color: #856404; }
    .action-banner { margin-top: 1rem; padding: 0.75rem; background: #fff3cd; border-left: 4px solid #856404; border-radius: 4px; }
    .table-wrapper { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e5e5e5; }
    th { background: #f6f6f6; font-weight: bold; }
  `]
})
export class CyberneticDashboardComponent {
  readonly cyberService = inject(CyberneticService);
}