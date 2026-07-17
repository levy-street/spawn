use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use quote::ToTokens;
use syn::punctuated::Punctuated;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Expr, ExprLit, ExprPath, File, ForeignItem, Item, ItemForeignMod, Lit, Local, Meta,
    Pat, Path as SynPath, Stmt, Token, UseTree,
};

fn cfg_requires_test(meta: &Meta) -> bool {
    match meta {
        Meta::Path(path) => path.is_ident("test"),
        Meta::List(list) if list.path.is_ident("all") || list.path.is_ident("any") => {
            let Ok(items) = list.parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated)
            else {
                return false;
            };
            if list.path.is_ident("all") {
                items.iter().any(cfg_requires_test)
            } else {
                !items.is_empty() && items.iter().all(cfg_requires_test)
            }
        }
        Meta::List(_) | Meta::NameValue(_) => false,
    }
}

fn cfg_test(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .parse_args::<Meta>()
                .is_ok_and(|meta| cfg_requires_test(&meta))
    })
}

fn path_string(path: &SynPath) -> String {
    path.segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

fn collect_use_tree(
    tree: &UseTree,
    prefix: &mut Vec<String>,
    aliases: &mut BTreeMap<String, Binding>,
) {
    match tree {
        UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            collect_use_tree(&path.tree, prefix, aliases);
            prefix.pop();
        }
        UseTree::Name(name) => {
            let mut full = prefix.clone();
            full.push(name.ident.to_string());
            aliases.insert(name.ident.to_string(), Binding::Resolved(full.join("::")));
        }
        UseTree::Rename(rename) => {
            let mut full = prefix.clone();
            full.push(rename.ident.to_string());
            aliases.insert(
                rename.rename.to_string(),
                Binding::Resolved(full.join("::")),
            );
        }
        UseTree::Group(group) => {
            for item in &group.items {
                collect_use_tree(item, prefix, aliases);
            }
        }
        UseTree::Glob(_) => {
            aliases.insert(format!("*{}", prefix.join("::")), Binding::Shadowed);
        }
    }
}

fn collect_use_globs(tree: &UseTree, prefix: &mut Vec<String>, globs: &mut Vec<String>) {
    match tree {
        UseTree::Path(path) => {
            prefix.push(path.ident.to_string());
            collect_use_globs(&path.tree, prefix, globs);
            prefix.pop();
        }
        UseTree::Group(group) => {
            for item in &group.items {
                collect_use_globs(item, prefix, globs);
            }
        }
        UseTree::Glob(_) => globs.push(prefix.join("::")),
        UseTree::Name(_) | UseTree::Rename(_) => {}
    }
}

fn effective_link_name(function: &syn::ForeignItemFn) -> Result<String, String> {
    for attribute in &function.attrs {
        if !attribute.path().is_ident("link_name") {
            continue;
        }
        let Meta::NameValue(name_value) = &attribute.meta else {
            return Err("link_name must be a name-value attribute".into());
        };
        let Expr::Lit(ExprLit {
            lit: Lit::Str(value),
            ..
        }) = &name_value.value
        else {
            return Err("link_name must contain a string literal".into());
        };
        return Ok(value.value());
    }
    Ok(function.sig.ident.to_string())
}

fn process_symbol(symbol: &str) -> bool {
    matches!(
        symbol,
        "execl"
            | "execle"
            | "execlp"
            | "execv"
            | "execve"
            | "execveat"
            | "execvp"
            | "execvpe"
            | "fexecve"
            | "posix_spawn"
            | "posix_spawnp"
            | "popen"
            | "system"
            | "syscall"
            | "dlopen"
            | "dlmopen"
            | "dlsym"
            | "dlvsym"
    )
}

fn known_process_function(path: &str) -> Option<&str> {
    let symbol = path.rsplit("::").next()?;
    let owner = path.strip_suffix(symbol)?.trim_end_matches("::");
    (process_symbol(symbol)
        && (owner.ends_with("libc")
            || owner.ends_with("nix::unistd")
            || owner.ends_with("std::process")))
    .then_some(symbol)
}

fn command_constructor(path: &str) -> bool {
    path.strip_suffix("::new").is_some_and(|owner| {
        matches!(
            owner,
            "std::process::Command" | "tokio::process::Command" | "async_process::Command"
        )
    })
}

fn encode_hex(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

#[derive(Clone)]
enum Binding {
    Resolved(String),
    Shadowed,
}

#[derive(Default)]
struct Scope {
    bindings: BTreeMap<String, Binding>,
    foreign: BTreeMap<String, String>,
}

struct Analyzer<'a> {
    relative: &'a str,
    scopes: Vec<Scope>,
    records: Vec<String>,
}

impl<'a> Analyzer<'a> {
    fn new(relative: &'a str) -> Self {
        Self {
            relative,
            scopes: vec![Scope::default()],
            records: Vec::new(),
        }
    }

    fn current_scope(&mut self) -> &mut Scope {
        self.scopes.last_mut().expect("analyzer scope")
    }

    fn bind_pattern(&mut self, pattern: &Pat, binding: Binding) {
        match pattern {
            Pat::Ident(ident) => {
                self.current_scope()
                    .bindings
                    .insert(ident.ident.to_string(), binding);
            }
            Pat::Reference(reference) => self.bind_pattern(&reference.pat, binding),
            Pat::Type(typed) => self.bind_pattern(&typed.pat, binding),
            Pat::Tuple(tuple) => {
                for element in &tuple.elems {
                    self.bind_pattern(element, Binding::Shadowed);
                }
            }
            Pat::Struct(structure) => {
                for field in &structure.fields {
                    self.bind_pattern(&field.pat, Binding::Shadowed);
                }
            }
            Pat::TupleStruct(tuple) => {
                for element in &tuple.elems {
                    self.bind_pattern(element, Binding::Shadowed);
                }
            }
            Pat::Slice(slice) => {
                for element in &slice.elems {
                    self.bind_pattern(element, Binding::Shadowed);
                }
            }
            Pat::Or(or_pattern) => {
                for case in &or_pattern.cases {
                    self.bind_pattern(case, Binding::Shadowed);
                }
            }
            _ => {}
        }
    }

    fn lookup_binding(&self, name: &str) -> Option<&Binding> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.bindings.get(name))
    }

    fn resolve_path(&self, raw: &str) -> (String, bool) {
        let mut current = raw.to_string();
        for _ in 0..16 {
            let (first, suffix) = current
                .split_once("::")
                .map_or((current.as_str(), ""), |(first, suffix)| (first, suffix));
            match self.lookup_binding(first) {
                Some(Binding::Resolved(replacement)) => {
                    let next = if suffix.is_empty() {
                        replacement.clone()
                    } else {
                        format!("{replacement}::{suffix}")
                    };
                    if next == current {
                        break;
                    }
                    current = next;
                }
                Some(Binding::Shadowed) => return (current, true),
                None => break,
            }
        }
        (current, false)
    }

    fn lookup_foreign(&self, name: &str) -> Option<&str> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.foreign.get(name).map(String::as_str))
    }

    fn bind_use(&mut self, tree: &UseTree) {
        let mut globs = Vec::new();
        collect_use_globs(tree, &mut Vec::new(), &mut globs);
        for glob in globs {
            self.records
                .push(format!("unresolved-use-glob\t{}\t{}", self.relative, glob));
        }
        collect_use_tree(tree, &mut Vec::new(), &mut self.current_scope().bindings);
    }

    fn bind_foreign(&mut self, foreign: &ItemForeignMod) {
        if cfg_test(&foreign.attrs) {
            return;
        }
        for item in &foreign.items {
            if let ForeignItem::Fn(function) = item {
                let rust_name = function.sig.ident.to_string();
                let symbol = effective_link_name(function)
                    .unwrap_or_else(|error| panic!("{}: {error}", self.relative));
                self.current_scope()
                    .foreign
                    .insert(rust_name.clone(), symbol.clone());
                self.records.push(format!(
                    "foreign-decl\t{}\t{}\t{}",
                    self.relative, rust_name, symbol
                ));
            }
        }
    }

    fn bind_item_scope<'b>(&mut self, items: impl Iterator<Item = &'b Item>) {
        for item in items {
            match item {
                Item::Use(item_use) if !cfg_test(&item_use.attrs) => self.bind_use(&item_use.tree),
                Item::ForeignMod(foreign) => self.bind_foreign(foreign),
                Item::Const(item_const) if !cfg_test(&item_const.attrs) => {
                    if let Expr::Path(path) = item_const.expr.as_ref() {
                        let (resolved, shadowed) = self.resolve_path(&path_string(&path.path));
                        self.current_scope().bindings.insert(
                            item_const.ident.to_string(),
                            if shadowed {
                                Binding::Shadowed
                            } else {
                                Binding::Resolved(resolved)
                            },
                        );
                    }
                }
                Item::Static(item_static) if !cfg_test(&item_static.attrs) => {
                    if let Expr::Path(path) = item_static.expr.as_ref() {
                        let (resolved, shadowed) = self.resolve_path(&path_string(&path.path));
                        self.current_scope().bindings.insert(
                            item_static.ident.to_string(),
                            if shadowed {
                                Binding::Shadowed
                            } else {
                                Binding::Resolved(resolved)
                            },
                        );
                    }
                }
                Item::Type(item_type) if !cfg_test(&item_type.attrs) => {
                    if let syn::Type::Path(path) = item_type.ty.as_ref() {
                        let (resolved, shadowed) = self.resolve_path(&path_string(&path.path));
                        self.current_scope().bindings.insert(
                            item_type.ident.to_string(),
                            if shadowed {
                                Binding::Shadowed
                            } else {
                                Binding::Resolved(resolved)
                            },
                        );
                    }
                }
                Item::ExternCrate(item_extern) if !cfg_test(&item_extern.attrs) => {
                    let local = item_extern.rename.as_ref().map_or_else(
                        || item_extern.ident.to_string(),
                        |(_, name)| name.to_string(),
                    );
                    self.current_scope()
                        .bindings
                        .insert(local, Binding::Resolved(item_extern.ident.to_string()));
                }
                _ => {}
            }
        }
    }

    fn record_call_path(&mut self, path: &ExprPath) {
        let raw = path_string(&path.path);
        let (resolved, shadowed) = self.resolve_path(&raw);
        if !shadowed && command_constructor(&resolved) {
            self.records
                .push(format!("process-call\t{}\tcommand-new", self.relative));
            return;
        }
        if !shadowed {
            if let Some(symbol) = known_process_function(&resolved) {
                self.records
                    .push(format!("process-call\t{}\t{symbol}", self.relative));
            }
        }
        if shadowed {
            return;
        }
        let foreign_name = resolved.rsplit("::").next().unwrap_or(&resolved);
        if let Some(symbol) = self.lookup_foreign(foreign_name).map(str::to_string) {
            self.records
                .push(format!("foreign-call\t{}\t{}", self.relative, symbol));
            if process_symbol(&symbol) {
                self.records.push(format!(
                    "process-call\t{}\tforeign:{}",
                    self.relative, symbol
                ));
            }
        }
    }

    fn record_macro(&mut self, node: &syn::Macro) {
        let path = path_string(&node.path);
        let tokens = node.tokens.to_string();
        self.records.push(format!(
            "macro-site\t{}\t{}\t{}",
            self.relative,
            path,
            encode_hex(&tokens)
        ));
    }

    fn record_attributes(&mut self, attributes: &[Attribute]) {
        for attribute in attributes {
            if attribute.path().is_ident("cfg") {
                continue;
            }
            let path = path_string(attribute.path());
            let tokens = attribute.meta.to_token_stream().to_string();
            self.records.push(format!(
                "attribute-site\t{}\t{}\t{}",
                self.relative,
                path,
                encode_hex(&tokens)
            ));
        }
    }
}

impl<'ast> Visit<'ast> for Analyzer<'_> {
    fn visit_file(&mut self, node: &'ast File) {
        self.bind_item_scope(node.items.iter());
        for item in &node.items {
            self.visit_item(item);
        }
    }

    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        if cfg_test(&node.attrs) {
            return;
        }
        self.record_attributes(&node.attrs);
        if let Some((_, items)) = &node.content {
            self.scopes.push(Scope::default());
            self.bind_item_scope(items.iter());
            for item in items {
                self.visit_item(item);
            }
            self.scopes.pop();
        }
    }

    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        if cfg_test(&node.attrs) {
            return;
        }
        self.record_attributes(&node.attrs);
        self.scopes.push(Scope::default());
        for argument in &node.sig.inputs {
            if let syn::FnArg::Typed(argument) = argument {
                self.bind_pattern(&argument.pat, Binding::Shadowed);
            }
        }
        self.visit_block(&node.block);
        self.scopes.pop();
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        if cfg_test(&node.attrs) {
            return;
        }
        self.record_attributes(&node.attrs);
        self.scopes.push(Scope::default());
        for argument in &node.sig.inputs {
            if let syn::FnArg::Typed(argument) = argument {
                self.bind_pattern(&argument.pat, Binding::Shadowed);
            }
        }
        self.visit_block(&node.block);
        self.scopes.pop();
    }

    fn visit_block(&mut self, node: &'ast syn::Block) {
        self.scopes.push(Scope::default());
        self.bind_item_scope(node.stmts.iter().filter_map(|statement| match statement {
            Stmt::Item(item) => Some(item),
            _ => None,
        }));
        for statement in &node.stmts {
            self.visit_stmt(statement);
        }
        self.scopes.pop();
    }

    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        self.record_attributes(&node.attrs);
    }

    fn visit_item_foreign_mod(&mut self, node: &'ast ItemForeignMod) {
        self.record_attributes(&node.attrs);
        for item in &node.items {
            if let ForeignItem::Fn(function) = item {
                self.record_attributes(&function.attrs);
            }
        }
    }

    fn visit_local(&mut self, node: &'ast Local) {
        if let Some(initializer) = &node.init {
            self.visit_expr(&initializer.expr);
            if let Some((_, diverge)) = &initializer.diverge {
                self.visit_expr(diverge);
            }
            let binding = if let Expr::Path(path) = initializer.expr.as_ref() {
                let (resolved, shadowed) = self.resolve_path(&path_string(&path.path));
                if shadowed {
                    Binding::Shadowed
                } else {
                    Binding::Resolved(resolved)
                }
            } else {
                Binding::Shadowed
            };
            self.bind_pattern(&node.pat, binding);
        } else {
            self.bind_pattern(&node.pat, Binding::Shadowed);
        }
    }

    fn visit_expr_assign(&mut self, node: &'ast syn::ExprAssign) {
        self.visit_expr(&node.right);
        if let Expr::Path(left) = node.left.as_ref() {
            if left.path.segments.len() == 1 {
                let binding = if let Expr::Path(right) = node.right.as_ref() {
                    let (resolved, shadowed) = self.resolve_path(&path_string(&right.path));
                    if shadowed {
                        Binding::Shadowed
                    } else {
                        Binding::Resolved(resolved)
                    }
                } else {
                    Binding::Shadowed
                };
                self.current_scope()
                    .bindings
                    .insert(path_string(&left.path), binding);
            }
        } else {
            self.visit_expr(&node.left);
        }
    }

    fn visit_expr_path(&mut self, node: &'ast ExprPath) {
        // Function items can be stored in tuples, fields, constants, or other
        // containers and invoked later. Inventory every expression reference,
        // not only paths that happen to be the immediate target of a call.
        self.record_call_path(node);
        visit::visit_expr_path(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        if node.method == "exec" {
            self.records
                .push(format!("process-call\t{}\tcommand-exec", self.relative));
        }
        visit::visit_expr_method_call(self, node);
    }

    fn visit_expr_closure(&mut self, node: &'ast syn::ExprClosure) {
        self.scopes.push(Scope::default());
        for input in &node.inputs {
            self.bind_pattern(input, Binding::Shadowed);
        }
        self.visit_expr(&node.body);
        self.scopes.pop();
    }

    fn visit_arm(&mut self, node: &'ast syn::Arm) {
        self.scopes.push(Scope::default());
        self.bind_pattern(&node.pat, Binding::Shadowed);
        if let Some((_, guard)) = &node.guard {
            self.visit_expr(guard);
        }
        self.visit_expr(&node.body);
        self.scopes.pop();
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        self.record_macro(node);
    }

    fn visit_attribute(&mut self, node: &'ast Attribute) {
        self.record_attributes(std::slice::from_ref(node));
    }
}

fn inventory(relative: &str, file: &File) -> Vec<String> {
    let mut analyzer = Analyzer::new(relative);
    analyzer.visit_file(file);
    analyzer.records
}

fn main() {
    let mut arguments = env::args_os().skip(1);
    let root = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("usage: host-tool-rust-guard ROOT RELATIVE.rs..."));
    let mut records = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in arguments {
        let relative = PathBuf::from(raw);
        let display = relative.to_string_lossy().replace('\\', "/");
        if !seen.insert(display.clone()) {
            panic!("duplicate Rust source: {display}");
        }
        let path = root.join(Path::new(&relative));
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        let file = syn::parse_file(&source)
            .unwrap_or_else(|error| panic!("cannot parse {display}: {error}"));
        records.push(format!("source-file\t{display}"));
        records.push(format!(
            "source-structure\t{}\t{}",
            display,
            encode_hex(&file.to_token_stream().to_string())
        ));
        records.extend(inventory(&display, &file));
    }
    records.sort();
    for record in records {
        println!("{record}");
    }
}
