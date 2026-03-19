import { Component, OnInit, DestroyRef, inject, ViewChild, ElementRef } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, EMPTY } from 'rxjs';
import { debounceTime, switchMap, catchError, finalize } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LeagueService } from './league.service';
import { Champion, BuildResult, BuildItem, DamageProfile, ItemStats } from './league.models';

@Component({
  selector: 'app-league',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, DecimalPipe],
  templateUrl: './league.component.html',
  styleUrls: ['./league.component.css'],
})
export class LeagueComponent implements OnInit {
  private readonly service = inject(LeagueService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('buildSection') buildSection?: ElementRef<HTMLElement>;
  @ViewChild('buildContainer') buildContainer?: ElementRef<HTMLElement>;

  // Champion data
  champions: Champion[] = [];
  filteredOwn: Champion[] = [];
  filteredEnemy: Champion[] = [];

  // Selections
  ownChampion: Champion | null = null;
  enemies: Champion[] = [];
  lanerKey: string | null = null;
  lanerOutKey: string | null = null;

  // Search inputs
  ownSearch = '';
  enemySearch = '';

  // Build state
  buildResult: BuildResult | null = null;
  buildError: string | null = null;
  buildLoading = false;
  buildRendered = false;

  private readonly buildTrigger$ = new Subject<void>();

  ngOnInit(): void {
    // Load champion list
    this.service.getChampions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: champions => { this.champions = champions; },
        error: () => { this.buildError = 'Failed to load champion list. Is the API running?'; }
      });

    // Build pipeline: debounce → cancel in-flight → fetch
    this.buildTrigger$.pipe(
      debounceTime(1000),
      switchMap(() => {
        // Guard: state may have changed during the debounce window
        if (!this.ownChampion || !this.lanerKey) {
          this.buildLoading = false;
          return EMPTY;
        }
        this.buildError = null;
        return this.service.getBuild(
          this.ownChampion.key,
          this.enemies.map(e => e.key),
          this.lanerKey
        ).pipe(
          catchError(() => {
            this.buildError = 'Failed to fetch build. Please try again.';
            return EMPTY;
          }),
          finalize(() => { this.buildLoading = false; })
        );
      }),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(result => {
      this.buildResult = result;
      this.buildRendered = true;
      this.renderBuild(result);
      setTimeout(() => this.buildSection?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    });
  }

  // ── Own champion ────────────────────────────────────────────────────────────

  onOwnSearch(query: string): void {
    this.ownSearch = query;
    this.filteredOwn = this.filterChampions(query, this.enemies.map(e => e.key));
  }

  onOwnEnter(): void {
    if (this.filteredOwn.length > 0) this.selectOwn(this.filteredOwn[0]);
  }

  ownChampionNew = false;

  selectOwn(champion: Champion): void {
    this.ownChampion = champion;
    this.ownSearch = '';
    this.filteredOwn = [];
    this.ownChampionNew = true;
    setTimeout(() => { this.ownChampionNew = false; }, 400);
    this.tryTriggerBuild();
  }

  removeOwn(): void {
    this.ownChampion = null;
    this.buildResult = null;
    this.buildError = null;
    this.clearBuild();
  }

  // ── Enemy champions ─────────────────────────────────────────────────────────

  onEnemySearch(query: string): void {
    this.enemySearch = query;
    const excluded = [...this.enemies.map(e => e.key), this.ownChampion?.key ?? ''].filter(Boolean);
    this.filteredEnemy = this.filterChampions(query, excluded);
  }

  onEnemyEnter(): void {
    if (this.filteredEnemy.length > 0) this.addEnemy(this.filteredEnemy[0]);
  }

  addEnemy(champion: Champion): void {
    if (this.enemies.length >= 5) return;
    this.enemies = [...this.enemies, champion];
    if (this.enemies.length === 1) this.lanerKey = champion.key;
    this.enemySearch = '';
    this.filteredEnemy = [];
    this.tryTriggerBuild();
  }

  removingChampions: Champion[] = [];

  removeEnemy(champion: Champion): void {
    // Update state immediately so search bar reappears right away
    this.enemies = this.enemies.filter(e => e.key !== champion.key);
    if (this.lanerKey === champion.key) {
      this.lanerKey = this.enemies[0]?.key ?? null;
    }
    this.buildResult = null;
    this.buildError = null;
    this.clearBuild();
    this.tryTriggerBuild();
    // Animate the pill out separately
    this.removingChampions = [...this.removingChampions, champion];
    setTimeout(() => {
      this.removingChampions = this.removingChampions.filter(c => c.key !== champion.key);
    }, 260);
  }

  setLaner(champion: Champion): void {
    if (this.lanerKey === champion.key) {
      this.lanerKey = null;
      this.lanerOutKey = champion.key;
      setTimeout(() => { this.lanerOutKey = null; }, 380);
    } else {
      this.lanerKey = champion.key;
    }
    this.buildResult = null;
    this.tryTriggerBuild();
  }

  // ── Damage bar widths ────────────────────────────────────────────────────────

  get barGreenWidth(): number {
    return this.enemies.length < 5 ? (this.enemies.length / 5) * 100 : 0;
  }

  get barAdWidth(): number {
    return this.enemies.length === 5 ? this.computeDamageProfile().adPercent : 0;
  }

  get barApWidth(): number {
    return this.enemies.length === 5 ? this.computeDamageProfile().apPercent : 0;
  }

  get barTrueWidth(): number {
    return this.enemies.length === 5 ? this.computeDamageProfile().truePercent : 0;
  }

  // ── Damage profile (weighted average from champion_builds.json) ──────────────

  computeDamageProfile(): DamageProfile {
    if (this.enemies.length === 0)
      return { adPercent: 0, apPercent: 0, truePercent: 0 };

    const totalPhysical = this.enemies.reduce((sum, e) =>
      sum + (e.damageProfile?.physical ?? (e.adaptiveType === 'PHYSICAL_DAMAGE' ? 80 : 20)), 0);
    const totalMagic = this.enemies.reduce((sum, e) =>
      sum + (e.damageProfile?.magic ?? (e.adaptiveType === 'MAGIC_DAMAGE' ? 80 : 20)), 0);

    const totalTrue = this.enemies.reduce((sum, e) =>
      sum + (e.damageProfile?.true ?? 0), 0);

    const n = this.enemies.length;
    const ad = totalPhysical / n;
    const ap = totalMagic / n;
    const tr = totalTrue / n;
    const total = ad + ap + tr || 1;

    return {
      adPercent:   (ad / total) * 100,
      apPercent:   (ap / total) * 100,
      truePercent: (tr / total) * 100,
    };
  }

  // ── Stat formatting ─────────────────────────────────────────────────────────

  formatStats(item: { stats: ItemStats }): string {
    const labels: Record<string, string> = {
      armor: 'Armor', magicResistance: 'MR', health: 'HP',
      abilityPower: 'AP', attackDamage: 'AD', movespeed: 'MS',
      attackSpeed: 'AS%', criticalStrikeChance: 'Crit%',
      mana: 'Mana', abilityHaste: 'AH', lethality: 'Leth',
      magicPenetration: 'MagPen', healAndShieldPower: 'H/SP%'
    };
    return Object.entries(item.stats as Record<string, number | undefined>)
      .filter(([, v]) => v != null && v > 0)
      .map(([k, v]) => `${labels[k] ?? k}: ${v}`)
      .join('  ·  ');
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private filterChampions(query: string, excludeKeys: string[]): Champion[] {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return this.champions
      .filter(c => !excludeKeys.includes(c.key) && c.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }

  private tryTriggerBuild(): void {
    this.buildResult = null;
    this.buildError = null;
    this.clearBuild();
    if (this.ownChampion && this.enemies.length === 5 && this.lanerKey) {
      this.buildLoading = true;
      this.buildTrigger$.next();
      setTimeout(() => {
        this.buildSection?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
  }

  private clearBuild(): void {
    if (this.buildContainer) {
      this.buildContainer.nativeElement.innerHTML = '';
    }
    this.buildRendered = false;
  }

  private renderBuild(result: BuildResult): void {
    const container = this.buildContainer?.nativeElement;
    if (!container) return;

    container.innerHTML = '';

    const isAdc = result.archetype === 'adc_crit' || result.archetype === 'adc_onhit';
    const regularItems = result.items.filter(i => !i.situational);
    const altItems = result.items.filter(i => i.situational);
    const combineAlts = !isAdc && altItems.length === 2;

    const label = document.createElement('div');
    label.className = 'build-label';
    label.textContent = 'RECOMMENDED BUILD';
    container.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'items-grid';
    regularItems.forEach((item, i) => grid.appendChild(this.createItemPill(item, i)));
    if (combineAlts) {
      grid.appendChild(this.createCombinedPill(altItems[0], altItems[1], regularItems.length));
    } else {
      altItems.forEach((item, i) => grid.appendChild(this.createItemPill(item, regularItems.length + i)));
    }
    container.appendChild(grid);

    const boots = result.boots;
    const row = document.createElement('div');
    row.className = 'boots-row';
    row.innerHTML = `
      <img src="${boots.icon}" alt="${boots.name}" class="item-icon" />
      <div class="boots-info">
        <span class="item-name">${boots.name}</span>
        ${boots.simpleDescription ? `<span class="boots-desc">${boots.simpleDescription}</span>` : ''}
      </div>
      <span class="boots-tag">
        BOOTS
        ${boots.bootsSource === 'matchup' ? '<span class="boots-badge">matchup</span>' : ''}
      </span>`;
    container.appendChild(row);
  }

  private createItemPill(item: BuildItem, index: number): HTMLElement {
    const pill = document.createElement('div');
    pill.className = 'item-pill' + (item.situational ? ' situational' : '') + (item.core ? ' core-item' : '');
    pill.style.animationDelay = `${index * 120}ms`;

    const statsStr = this.formatStats(item);
    pill.innerHTML = `
      <img src="${item.icon}" alt="${item.name}" class="item-icon" />
      <span class="item-name">${item.name}</span>
      ${item.simpleDescription ? `<span class="item-desc">${item.simpleDescription}</span>` : ''}
      <div class="item-tooltip">
        <p class="tooltip-name">${item.name}</p>
        <p class="tooltip-cost">${item.goldTotal}</p>
        ${statsStr ? `<p class="tooltip-stats">${statsStr}</p>` : ''}
      </div>`;
    return pill;
  }

  private createCombinedPill(item1: BuildItem, item2: BuildItem, startIndex: number): HTMLElement {
    const pill = document.createElement('div');
    pill.className = 'item-pill situational combined-pill';
    pill.style.animationDelay = `${startIndex * 120}ms`;
    pill.style.gridColumn = 'span 2';

    const stats1 = this.formatStats(item1);
    const stats2 = this.formatStats(item2);
    pill.innerHTML = `
      <div class="combined-slot">
        <img src="${item1.icon}" alt="${item1.name}" class="combined-icon" />
        <span class="item-name">${item1.name}</span>
        ${item1.simpleDescription ? `<span class="item-desc">${item1.simpleDescription}</span>` : ''}
        <div class="item-tooltip">
          <p class="tooltip-name">${item1.name}</p>
          <p class="tooltip-cost">${item1.goldTotal}</p>
          ${stats1 ? `<p class="tooltip-stats">${stats1}</p>` : ''}
        </div>
      </div>
      <div class="combined-or">OR</div>
      <div class="combined-slot">
        <img src="${item2.icon}" alt="${item2.name}" class="combined-icon" />
        <span class="item-name">${item2.name}</span>
        ${item2.simpleDescription ? `<span class="item-desc">${item2.simpleDescription}</span>` : ''}
        <div class="item-tooltip">
          <p class="tooltip-name">${item2.name}</p>
          <p class="tooltip-cost">${item2.goldTotal}</p>
          ${stats2 ? `<p class="tooltip-stats">${stats2}</p>` : ''}
        </div>
      </div>`;
    return pill;
  }
}
