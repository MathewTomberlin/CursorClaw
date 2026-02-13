export interface ChangeSuggestionInput {
  files: string[];
  maxSuggestions?: number;
}

export class ProactiveSuggestionEngine {
  suggest(input: ChangeSuggestionInput): string[] {
    const maxSuggestions = Math.max(1, Math.min(10, input.maxSuggestions ?? 3));
    const lower = input.files.map((file) => file.toLowerCase());
    const suggestions = new Set<string>();

    if (lower.some((file) => /(auth|login|session|token|oauth|permission)/.test(file))) {
      suggestions.add(
        "I noticed Auth-related changes. Would you like me to update related tests and API/security documentation?"
      );
    }
    if (lower.some((file) => /(schema|migration|db|database|model)/.test(file))) {
      suggestions.add(
        "Database or schema files changed. Should I generate migration safety checks and rollback notes?"
      );
    }
    if (lower.some((file) => /(api|route|controller|gateway)/.test(file))) {
      suggestions.add(
        "API surface appears updated. Would you like a compatibility review plus contract test updates?"
      );
    }
    if (lower.some((file) => /(readme|docs|spec|md$)/.test(file))) {
      suggestions.add(
        "Documentation changed. I can verify related code snippets and keep examples consistent."
      );
    }
    if (lower.some((file) => /(test|spec)/.test(file))) {
      suggestions.add(
        "Tests were modified. Do you want me to check for uncovered regression scenarios in adjacent modules?"
      );
    }

    return [...suggestions].slice(0, maxSuggestions);
  }
}
