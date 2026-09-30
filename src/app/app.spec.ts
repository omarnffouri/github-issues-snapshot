import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';
import { App } from './app';
import { IssuesSnapshot } from './issues-snapshot';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function render(snapshot: IssuesSnapshot): Promise<HTMLElement> {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => snapshot,
      }),
    );
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows a clear empty state for a generated snapshot with no issues', async () => {
    const page = await render({
      repository: { nameWithOwner: 'example/project', url: 'https://github.com/example/project' },
      generatedAt: '2026-10-01T10:00:00Z',
      issues: [],
    });

    expect(page.textContent).toContain('No open issues');
    expect(page.textContent).toContain('0 open');
  });

  it('renders the required fields and links an open issue', async () => {
    const page = await render({
      repository: { nameWithOwner: 'example/project', url: 'https://github.com/example/project' },
      generatedAt: '2026-10-01T10:00:00Z',
      issues: [
        {
          number: 42,
          title: 'Fix the menu',
          url: 'https://github.com/example/project/issues/42',
          labels: ['bug', 'mobile'],
          author: 'octocat',
          openedAt: '2026-09-30T10:00:00Z',
        },
      ],
    });

    const issueLink = page.querySelector<HTMLAnchorElement>('.issue-heading a');
    expect(issueLink?.textContent).toContain('Fix the menu');
    expect(issueLink?.href).toBe('https://github.com/example/project/issues/42');
    expect(page.textContent).toContain('#42');
    expect(page.textContent).toContain('bug');
    expect(page.textContent).toContain('mobile');
    expect(page.textContent).toContain('octocat');
    expect(page.querySelector('time[datetime="2026-09-30T10:00:00Z"]')).not.toBeNull();
  });
});
