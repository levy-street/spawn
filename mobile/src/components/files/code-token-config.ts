import type { CodeLanguage } from "@/components/files/types";

export interface LanguageConfig {
  lineComments: string[];
  blockComment: [string, string] | null;
  quotes: string[];
  multilineQuotes: string[];
  tripleQuotes: string[];
  escapes: boolean;
  keywords: Set<string>;
  caseInsensitive?: boolean;
  markup?: boolean;
}

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/u).filter(Boolean));
}

const C_LIKE = words(`
  if else for while do switch case default break continue return goto class struct enum union
  interface extends implements new delete this super public private protected static final abstract
  virtual override try catch finally throw throws const let var int long short char float double void
  bool boolean auto namespace using typedef template typename operator sizeof import export package
  module def end nil true false null undefined self
`);

const jsWords = words(`
  if else for while do switch case default break continue return function class extends new delete
  typeof instanceof in of var let const async await yield try catch finally throw import export from
  as default this super static get set true false null undefined void
`);

export const LANGUAGE_CONFIGS: Record<CodeLanguage, LanguageConfig> = {
  "c-like": {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: C_LIKE,
  },
  js: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: jsWords,
  },
  ts: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: new Set([
      ...jsWords,
      ...words(
        "implements interface type enum namespace declare abstract readonly keyof infer satisfies public private protected optional never unknown any string number boolean",
      ),
    ]),
  },
  jsx: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: new Set([
      ...jsWords,
      ...words("implements interface type enum namespace declare abstract readonly"),
    ]),
  },
  python: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: ['"""', "'''"],
    escapes: true,
    keywords: words(
      "def class lambda return yield pass break continue if elif else for while with as try except finally raise assert import from global nonlocal del in is not and or True False None self async await match case",
    ),
  },
  shell: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words(
      "if then elif else fi for while until do done case esac function return exit break continue local export readonly declare source echo cd set unset trap shift eval exec test in select time",
    ),
  },
  rust: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"'],
    multilineQuotes: ['"'],
    tripleQuotes: [],
    escapes: true,
    keywords: words(
      "fn let mut const static struct enum trait impl for while loop if else match return break continue where type use mod pub crate self super as in ref move dyn async await unsafe extern true false Some None Ok Err",
    ),
  },
  go: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: words(
      "func var const type struct interface map chan package import if else for range switch case default break continue return go defer select fallthrough goto true false nil iota make new len cap append",
    ),
  },
  css: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words(
      "important inherit initial unset auto none from to media supports keyframes import charset font-face",
    ),
  },
  json: {
    lineComments: [],
    blockComment: null,
    quotes: ['"'],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words("true false null"),
  },
  yaml: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words("true false null yes no on off"),
  },
  toml: {
    lineComments: ["#", ";"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: ['"""', "'''"],
    escapes: true,
    keywords: words("true false"),
  },
  sql: {
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    quotes: ["'", '"'],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    caseInsensitive: true,
    keywords: words(
      "select from where group by having order limit offset insert into values update set delete create table drop alter add index view join inner left right outer full on as union all distinct and or not null is in like between exists case when then else end primary key foreign references unique default constraint returning begin commit rollback with recursive",
    ),
  },
  xml: {
    lineComments: [],
    blockComment: ["<!--", "-->"],
    quotes: ['"', "'"],
    multilineQuotes: ['"', "'"],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
    markup: true,
  },
  markdown: {
    lineComments: [],
    blockComment: null,
    quotes: [],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
  },
  plain: {
    lineComments: [],
    blockComment: null,
    quotes: [],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
  },
};
