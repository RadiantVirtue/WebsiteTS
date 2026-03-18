import { AfterViewInit, Directive, ElementRef, inject } from '@angular/core';

@Directive({ selector: '[scrollReveal]', standalone: true })
export class ScrollRevealDirective implements AfterViewInit {
  private observer!: IntersectionObserver;
  private readonly el = inject(ElementRef);

  ngAfterViewInit(): void {
    this.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          this.observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    this.observeAll();
  }

  /** Re-scan for new `.reveal` elements (e.g. after conditional blocks render). */
  observeAll(): void {
    this.el.nativeElement
      .querySelectorAll('.reveal:not(.visible)')
      .forEach((el: Element) => this.observer.observe(el));
  }
}
