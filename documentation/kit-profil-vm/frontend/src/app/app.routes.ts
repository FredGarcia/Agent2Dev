import { Routes } from '@angular/router';
import { CyberneticDashboardComponent } from './cybernetic/cybernetic-dashboard.component';

export const routes: Routes = [
  { path: '', component: CyberneticDashboardComponent },
  { path: '**', redirectTo: '' }
];