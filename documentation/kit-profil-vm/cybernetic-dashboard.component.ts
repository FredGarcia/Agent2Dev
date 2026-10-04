import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CyberneticService } from './cybernetic.service';

@Component({
    selector: 'app-cybernetic-dashboard',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="dashboard-container">
      <header>
        <h1>Méta-Système Cybernétique 7E</h1>
        <span class="badge" [ngClass]="{ 'online': cyberService.isConnected() }">
          {{ cyberService.isConnected() ? 'EN DIRECT' : 'DÉCONNECTÉ' }}
        </span>
      </header>

      <!-- ÉTAT COURANT (7E) -->
      @if (cyberService.currentCycle(); as current) {
        <section class="card current-state">
          <h2>Cycle Courant : #{{ current.cycle_number }}</h2>
          <p><strong>Statut :</strong> <span [class]="current.status">{{ current.status }}</span></p>
          <p><strong>Conteneurs Actifs :</strong> {{ current.metrics.running }} / {{ current.metrics.total }}</p>
          <p><strong>Redémarrages Cumulés :</strong> {{ current.metrics.restarts }}</p>
          
          @if (current.action_taken) {
            <div class="alert action">
              <strong>Action Rétroactive :</strong> {{ current.action_taken.type }}
            </div>
          }
        </section>
      }

      <!-- HISTORIQUE DES TRANSITIONS -->
      <section class="card history">
        <h3>Historique des transitions (PostgreSQL)</h3>
        <table>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Horodatage</th>
              <th>Statut</th>
              <th>Conteneurs</th>
            </tr>
          </thead>
          <tbody>
            @for (cycle of cyberService.cycleHistory(); track cycle.id) {
              <tr>
                <td>#{{ cycle.cycle_number }}</td>
                <td>{{ cycle.created_at | date:'HH:mm:ss' }}</td>
                <td><span [class]="cycle.status">{{ cycle.status }}</span></td>
                <td>{{ cycle.metrics.running }}/{{ cycle.metrics.total }}</td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    </div>
  `,
    styles: [`
    .dashboard-container { padding: 20px; font-family: sans-serif; }
    .card { background: #f8f9fa; border-radius: 8px; padding: 15px; margin-bottom: 20px; border: 1px solid #ddd; }
    .badge { padding: 4px 8px; border-radius: 4px; background: #dc3545; color: white; font-size: 0.8rem; }
    .badge.online { background: #28a745; }
    .HEALTHY { color: #28a745; font-weight: bold; }
    .DEGRADED { color: #dc3545; font-weight: bold; }
    .alert.action { background: #fff3cd; color: #856404; padding: 10px; border-radius: 4px; margin-top: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
  `]
})
export class CyberneticDashboardComponent {
    readonly cyberService = inject(CyberneticService);
}