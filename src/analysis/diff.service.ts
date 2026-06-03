import { Injectable } from '@nestjs/common';

export interface DiffFile {
  filename: string;
  patch: string;
  status: string;
}

export interface DiffBatch {
  files: DiffFile[];
}

@Injectable()
export class DiffService {
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  splitIntoBatches(files: DiffFile[], maxTokens: number): DiffBatch[] {
    const batches: DiffBatch[] = [];
    let currentBatch: DiffFile[] = [];
    let currentTokens = 0;

    for (const file of files) {
      const fileTokens = this.estimateTokens(`${file.filename}\n${file.patch}`);

      if (currentBatch.length > 0 && currentTokens + fileTokens > maxTokens) {
        batches.push({ files: currentBatch });
        currentBatch = [file];
        currentTokens = fileTokens;
      } else {
        currentBatch.push(file);
        currentTokens += fileTokens;
      }
    }

    if (currentBatch.length > 0) {
      batches.push({ files: currentBatch });
    }

    return batches;
  }

  formatDiffForPrompt(files: DiffFile[]): string {
    return files
      .map((f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
      .join('\n\n');
  }
}
