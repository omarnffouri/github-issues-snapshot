import { DatePipe } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { IssuesSnapshot } from './issues-snapshot';

type LoadStatus = 'loading' | 'pending' | 'ready' | 'error';

@Component({
  imports: [DatePipe],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly status = signal<LoadStatus>('loading');
  protected readonly snapshot = signal<IssuesSnapshot | null>(null);

  ngOnInit(): void {
    void this.loadSnapshot();
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const url = new URL('issues.json', document.baseURI);
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Snapshot request failed: ${response.status}`);
      }

      const data = (await response.json()) as IssuesSnapshot;
      if (!data || !Array.isArray(data.issues)) {
        throw new Error('Invalid issue snapshot');
      }

      this.snapshot.set(data);
      this.status.set(data.repository && data.generatedAt ? 'ready' : 'pending');
    } catch {
      this.status.set('error');
    }
  }
}
