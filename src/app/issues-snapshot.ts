export interface Issue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  author: string | null;
  openedAt: string;
}

export interface IssuesSnapshot {
  repository: {
    nameWithOwner: string;
    url: string;
  } | null;
  generatedAt: string | null;
  issues: Issue[];
}
