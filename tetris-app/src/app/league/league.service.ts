import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Champion, BuildResult } from './league.models';

@Injectable({ providedIn: 'root' })
export class LeagueService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  getChampions(): Observable<Champion[]> {
    return this.http.get<Champion[]>(`${this.base}/champions`);
  }

  getBuild(championKey: string, enemies: string[], laner: string): Observable<BuildResult> {
    const params = `enemies=${enemies.join(',')}&laner=${laner}`;
    return this.http.get<BuildResult>(`${this.base}/build/${championKey}?${params}`);
  }
}
