import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ScrollRevealDirective } from '../shared/scroll-reveal.directive';
import { UI } from '../tetris-replay/replay.constants';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink, ScrollRevealDirective],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('heroInner') heroInnerRef!: ElementRef<HTMLElement>;
  @ViewChild('scrollHint') scrollHintRef!: ElementRef<HTMLElement>;
  @ViewChild('projectsGrid') projectsGridRef!: ElementRef<HTMLElement>;

  toastMessage = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private cardsObserver: IntersectionObserver | null = null;

  ngAfterViewInit(): void {
    this.cardsObserver = new IntersectionObserver(
      ([entry]) => {
        entry.target.classList.toggle('cards-visible', entry.isIntersecting);
      },
      { threshold: 0.2 }
    );
    this.cardsObserver.observe(this.projectsGridRef.nativeElement);
  }

  ngOnDestroy(): void {
    this.cardsObserver?.disconnect();
  }

  @HostListener('window:scroll')
  onScroll(): void {
    const y = window.scrollY;
    this.heroInnerRef.nativeElement.style.transform = `translateY(${y * 0.3}px)`;
    this.scrollHintRef.nativeElement.classList.toggle('hidden', y > 0);
  }

  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  }

  copy(text: string, label: string): void {
    navigator.clipboard.writeText(text).then(() => {
      if (this.toastTimer !== null) clearTimeout(this.toastTimer);
      this.toastMessage = `${label} copied`;
      this.toastTimer = window.setTimeout(() => { this.toastMessage = ''; }, UI.TOAST_DURATION_MS);
    });
  }
}
