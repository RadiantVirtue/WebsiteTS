import { Routes } from '@angular/router';
import { HomeComponent } from './home/home.component';
import { TetrisReplayComponent } from './tetris-replay/tetris-replay.component';

export const routes: Routes = [
  { path: '',      component: HomeComponent },
  { path: 'tetris', component: TetrisReplayComponent },
  { path: 'league', loadComponent: () => import('./league/league.component').then(m => m.LeagueComponent) },
  { path: '**',    redirectTo: '' },
];
