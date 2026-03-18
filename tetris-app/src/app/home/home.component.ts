import { Component, ElementRef, HostListener, ViewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomeComponent {
  @ViewChild('heroInner') heroInnerRef!: ElementRef<HTMLElement>;
  @ViewChild('scrollHint') scrollHintRef!: ElementRef<HTMLElement>;

  toastMessage = '';
  private toastTimer = 0;

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
      clearTimeout(this.toastTimer);
      this.toastMessage = `${label} copied`;
      this.toastTimer = window.setTimeout(() => { this.toastMessage = ''; }, 2000);
    });
  }
}
