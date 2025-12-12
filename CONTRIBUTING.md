# Contributing to EKSPressJS

Thank you for your interest in contributing to EKSPressJS!

## Development Setup

1. Clone the repository
```bash
git clone <repository-url>
cd ekspressjs
```

2. Install dependencies
```bash
npm install
```

3. Build the project
```bash
npm run build
```

4. Link locally for testing
```bash
npm link
```

Now you can use `ekspressjs` command globally, or test with:
```bash
npx ekspressjs --app next
```

## Project Structure

```
ekspressjs/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── deploy.ts           # Main deployment logic
│   ├── prompts.ts          # User input prompts
│   ├── aws-utils.ts        # AWS SDK utilities
│   ├── utils.ts            # Helper utilities
│   ├── types.ts            # TypeScript type definitions
│   └── templates/
│       ├── dockerfile.ts   # Dockerfile generators
│       └── kubernetes.ts   # K8s manifest generators
├── dist/                   # Compiled JavaScript (generated)
├── package.json
└── tsconfig.json
```

## Adding New App Types

To add support for a new application type:

1. Add the app type to `src/types.ts`:
```typescript
export type AppType = 'next' | 'nuxt' | 'node' | 'nest' | 'react' | 'vue' | 'your-new-type';
```

2. Add Dockerfile template in `src/templates/dockerfile.ts`:
```typescript
yourNewType: `# Your App Type Dockerfile
FROM node:18-alpine
...
`,
```

3. Update CLI validation in `src/cli.ts`:
```typescript
const validAppTypes = ['next', 'nuxt', ..., 'your-new-type'];
```

4. Update README.md with the new app type

## Testing

Before submitting a PR:

1. Build the project: `npm run build`
2. Test locally with a sample project
3. Ensure all TypeScript types are correct
4. Check for linting errors

## Submitting Changes

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Submit a pull request with a clear description

## Code Style

- Use TypeScript strict mode
- Follow existing code style
- Add comments for complex logic
- Keep functions focused and small

