-module(spawnd_host).

-include_lib("kernel/include/file.hrl").

-export([fs_list/1, tools_check/1, tool_install/1, save_upload/1, expand_path/1, resolve_executable/2]).

-define(INSTALL_TIMEOUT_MS, 170000).
-define(VERSION_TIMEOUT_MS, 2000).

fs_list(Path0) ->
    Path = expand_path(Path0),
    Parent =
        case filename:dirname(Path) of
            "." -> null;
            P -> list_to_binary(P)
        end,
    Entries =
        case file:list_dir(Path) of
            {ok, Names} ->
                Dirs = [entry(Path, Name) || Name <- Names, is_dir(filename:join(Path, Name))],
                lists:sort(fun(#{<<"name">> := A}, #{<<"name">> := B}) -> A =< B end, Dirs);
            {error, _} ->
                []
        end,
    Error =
        case file:list_dir(Path) of
            {ok, _} -> null;
            {error, Reason} -> list_to_binary(file:format_error(Reason))
        end,
    #{
        <<"path">> => list_to_binary(Path),
        <<"home_dir">> => list_to_binary(spawnd_config:home_dir()),
        <<"parent">> => Parent,
        <<"entries">> => Entries,
        <<"error">> => Error
    }.

tools_check(Targets) ->
    [tool_status(T) || T <- Targets].

tool_install(Target) ->
    Install = maps:get(<<"install">>, Target, <<>>),
    Capture = shell_capture(Install, ?INSTALL_TIMEOUT_MS),
    Status = tool_status(Target),
    maps:merge(Capture, #{
        <<"preset_id">> => maps:get(<<"preset_id">>, Target, <<>>),
        <<"preset_name">> => maps:get(<<"preset_name">>, Target, <<>>),
        <<"agent_kind">> => maps:get(<<"agent_kind">>, Target, <<>>),
        <<"command">> => maps:get(<<"command">>, Target, <<>>),
        <<"install">> => Install,
        <<"status">> => Status
    }).

save_upload(Obj) ->
    Cwd = maps:get(<<"cwd">>, Obj, spawnd_config:home_dir()),
    Name = safe_name(maps:get(<<"name">>, Obj, <<"upload">>)),
    Destination = maps:get(<<"destination">>, Obj, null),
    Base =
        case Destination of
            <<"cwd">> -> expand_path(Cwd);
            _ -> filename:join([expand_path(Cwd), ".spawn", "attachments"])
    end,
    ok = filelib:ensure_dir(filename:join(Base, "x")),
    Bytes = base64:decode(maps:get(<<"bytes_b64">>, Obj)),
    case write_unique(Base, binary_to_list(Name), Bytes) of
        {ok, Path} -> list_to_binary(Path);
        {error, Reason} -> error({upload_failed, Reason})
    end.

entry(Dir, Name) ->
    Path = filename:join(Dir, Name),
    #{<<"name">> => list_to_binary(Name), <<"path">> => list_to_binary(Path)}.

is_dir(Path) ->
    case filelib:is_dir(Path) of
        true -> true;
        false -> false
    end.

tool_status(Target) ->
    Command = maps:get(<<"command">>, Target, <<>>),
    Path0 = resolve_executable(Command, maps:get(<<"env">>, Target, #{})),
    Path = path_out(Path0),
    Version =
        case Path0 of
            false -> null;
            _ -> version(Path0)
        end,
    #{
        <<"preset_id">> => maps:get(<<"preset_id">>, Target, <<>>),
        <<"preset_name">> => maps:get(<<"preset_name">>, Target, <<>>),
        <<"agent_kind">> => maps:get(<<"agent_kind">>, Target, <<>>),
        <<"command">> => Command,
        <<"install">> => maps:get(<<"install">>, Target, null),
        <<"installed">> => Path =/= null,
        <<"path">> => Path,
        <<"version">> => Version,
        <<"latest_version">> => null,
        <<"update_available">> => null,
        <<"error">> => null
    }.

resolve_executable(<<>>, _Env) ->
    false;
resolve_executable(Command0, Env) ->
    Command = to_list(Command0),
    case filename:pathtype(Command) of
        absolute ->
            case executable_path(Command) of
                true -> Command;
                false -> false
            end;
        _ ->
            {Path, Source} = path_from_env(Env),
            Candidates = executable_candidates(Command, Path),
            case Source of
                explicit -> choose_first_candidate(Candidates);
                ambient -> choose_best_candidate(Candidates)
            end
    end.

path_out(false) ->
    null;
path_out(Path) ->
    list_to_binary(Path).

version(<<>>) ->
    null;
version(Command) ->
    Cmd = shell_quote(Command) ++ " --version 2>&1 | sed -n '1p'",
    Capture = shell_capture(Cmd, ?VERSION_TIMEOUT_MS),
    case string:trim(maps:get(<<"output">>, Capture, <<>>)) of
        <<>> -> null;
        Line -> Line
    end.

executable_candidates(Command, Path) ->
    unique_paths([
        maybe_unwrap_launcher(filename:join(Dir, Command))
        || Dir <- string:split(Path, ":", all),
           Dir =/= "",
           executable_path(filename:join(Dir, Command))
    ]).

path_from_env(Env) when is_map(Env) ->
    case maps:find(<<"PATH">>, Env) of
        {ok, Path} -> {to_list(Path), explicit};
        error ->
            case maps:find("PATH", Env) of
                {ok, Path} -> {to_list(Path), explicit};
                error -> path_from_process()
            end
    end;
path_from_env(Env) when is_list(Env) ->
    case lists:keyfind("PATH", 1, Env) of
        {"PATH", Path} -> {to_list(Path), explicit};
        false ->
            case lists:keyfind(<<"PATH">>, 1, Env) of
                {<<"PATH">>, Path} -> {to_list(Path), explicit};
                false -> path_from_process()
            end
    end;
path_from_env(_) ->
    path_from_process().

path_from_process() ->
    case os:getenv("PATH") of
        false -> {"", ambient};
        Path -> {Path, ambient}
    end.

executable_path(Path) ->
    case file:read_file_info(Path) of
        {ok, #file_info{type = regular, mode = Mode}} when Mode band 8#111 =/= 0 -> true;
        _ -> false
    end.

maybe_unwrap_launcher(Path) ->
    case real_path(Path) of
        RealPath ->
            case filename:basename(RealPath) of
                "codex.js" ->
                    case codex_native_binary(RealPath) of
                        false -> Path;
                        NativePath -> NativePath
                    end;
                _ ->
                    Path
            end
    end.

real_path(Path) ->
    real_path(Path, 0).

real_path(Path, Depth) when Depth >= 16 ->
    normalize_path(filename:absname(Path));
real_path(Path, Depth) ->
    case file:read_link(Path) of
        {ok, Target0} ->
            Target = case filename:pathtype(Target0) of
                absolute -> normalize_path(Target0);
                _ -> filename:join(filename:dirname(Path), Target0)
            end,
            real_path(normalize_path(filename:absname(Target)), Depth + 1);
        _ ->
            normalize_path(filename:absname(Path))
    end.

normalize_path(Path) ->
    Segments = filename:split(Path),
    filename:join(lists:reverse(normalize_segments(Segments, []))).

normalize_segments([], Acc) ->
    Acc;
normalize_segments(["." | Rest], Acc) ->
    normalize_segments(Rest, Acc);
normalize_segments([".." | Rest], ["/"]) ->
    normalize_segments(Rest, ["/"]);
normalize_segments([".." | Rest], []) ->
    normalize_segments(Rest, [".."]);
normalize_segments([".." | Rest], [".." | _] = Acc) ->
    normalize_segments(Rest, [".." | Acc]);
normalize_segments([".." | Rest], [_Segment | Acc]) ->
    normalize_segments(Rest, Acc);
normalize_segments([Segment | Rest], Acc) ->
    normalize_segments(Rest, [Segment | Acc]).

codex_native_binary(CodexJsPath) ->
    PackageRoot = filename:dirname(filename:dirname(CodexJsPath)),
    Patterns = [
        filename:join([PackageRoot, "node_modules", "@openai", "codex-*", "vendor", "*", "bin", "codex"]),
        filename:join([PackageRoot, "vendor", "*", "bin", "codex"]),
        filename:join([PackageRoot, "node_modules", "@openai", "codex-*", "vendor", "*", "codex", "codex"]),
        filename:join([PackageRoot, "vendor", "*", "codex", "codex"])
    ],
    case [Candidate || Pattern <- Patterns, Candidate <- filelib:wildcard(Pattern), executable_path(Candidate)] of
        [NativePath | _] -> NativePath;
        [] -> false
    end.

choose_best_candidate([]) ->
    false;
choose_best_candidate([Path]) ->
    Path;
choose_best_candidate(Paths) ->
    Versioned = [
        {Path, Parsed}
        || Path <- Paths,
           Parsed <- [parse_version(version(Path))],
           Parsed =/= undefined
    ],
    case Versioned of
        [] -> hd(Paths);
        _ -> best_versioned(Versioned)
    end.

choose_first_candidate([]) ->
    false;
choose_first_candidate([Path | _]) ->
    Path.

best_versioned([{Path, Version} | Rest]) ->
    {BestPath, _BestVersion} = lists:foldl(
        fun
            ({CandidatePath, CandidateVersion}, {_Path, BestVersion})
                when CandidateVersion > BestVersion ->
                {CandidatePath, CandidateVersion};
            (_Candidate, Best) ->
                Best
        end,
        {Path, Version},
        Rest
    ),
    BestPath.

parse_version(null) ->
    undefined;
parse_version(Line) when is_binary(Line) ->
    parse_version(binary_to_list(Line));
parse_version(Line) ->
    case re:run(Line, "([0-9]+)\\.([0-9]+)(?:\\.([0-9]+))?", [{capture, [1, 2, 3], list}]) of
        {match, [Major, Minor, Patch]} ->
            {list_to_integer(Major), list_to_integer(Minor), version_part(Patch)};
        {match, [Major, Minor]} ->
            {list_to_integer(Major), list_to_integer(Minor), 0};
        nomatch ->
            undefined
    end.

version_part([]) ->
    0;
version_part(Value) ->
    list_to_integer(Value).

unique_paths(Paths) ->
    {Unique, _Seen} = lists:foldl(
        fun(Path, {Acc, Seen}) ->
            case maps:is_key(Path, Seen) of
                true -> {Acc, Seen};
                false -> {[Path | Acc], Seen#{Path => true}}
            end
        end,
        {[], #{}},
        Paths
    ),
    lists:reverse(Unique).

shell_capture(Install, _Timeout) when Install =:= <<>>; Install =:= null ->
    #{<<"success">> => false, <<"exit_code">> => null, <<"output">> => <<>>, <<"error">> => <<"preset has no install command">>};
shell_capture(Install, Timeout) ->
    run_shell_capture(Install, Timeout).

run_shell_capture(Install, Timeout) ->
    Script = temp_script_path(),
    ok = file:write_file(Script, iolist_to_binary(["#!/bin/sh\n", to_list(Install), "\n"])),
    ok = file:change_mode(Script, 8#700),
    Port = open_port(
        {spawn_executable, "/bin/sh"},
        [binary, exit_status, stderr_to_stdout, use_stdio, {args, ["-c", shell_quote(Script)]}]
    ),
    collect_shell_capture(Port, Script, max(1, Timeout), []).

collect_shell_capture(Port, Script, Timeout, Chunks) ->
    receive
        {Port, {data, Data}} ->
            collect_shell_capture(Port, Script, Timeout, [Data | Chunks]);
        {Port, {exit_status, ExitCode}} ->
            _ = file:delete(Script),
            #{
                <<"success">> => ExitCode =:= 0,
                <<"exit_code">> => ExitCode,
                <<"output">> => iolist_to_binary(lists:reverse(Chunks)),
                <<"error">> => null
            }
    after Timeout ->
        kill_port_process_tree(Port),
        Output = drain_shell_capture(Port, 1000, Chunks),
        _ = file:delete(Script),
        #{
            <<"success">> => false,
            <<"exit_code">> => null,
            <<"output">> => Output,
            <<"error">> => <<"install timed out">>
        }
    end.

drain_shell_capture(Port, Timeout, Chunks) ->
    receive
        {Port, {data, Data}} ->
            drain_shell_capture(Port, Timeout, [Data | Chunks]);
        {Port, {exit_status, _ExitCode}} ->
            iolist_to_binary(lists:reverse(Chunks))
    after Timeout ->
        iolist_to_binary(lists:reverse(Chunks))
    end.

kill_port_process_tree(Port) ->
    Pid =
        case erlang:port_info(Port, os_pid) of
            {os_pid, OsPid} when is_integer(OsPid) -> OsPid;
            _ -> undefined
        end,
    case Pid of
        undefined ->
            _ = catch port_close(Port),
            ok;
        _ ->
            _ = os:cmd(kill_tree_command(Pid, "TERM")),
            _ = os:cmd(kill_tree_command(Pid, "KILL")),
            _ = catch port_close(Port),
            ok
    end.

kill_tree_command(Pid, Signal) ->
    lists:flatten(
        io_lib:format(
            "kill_tree() { for child in $(pgrep -P \"$1\" 2>/dev/null); do kill_tree \"$child\" \"$2\"; done; kill -\"$2\" \"$1\" 2>/dev/null || true; }; kill_tree ~B ~s",
            [Pid, Signal]
        )
    ).

temp_script_path() ->
    filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-install-" ++ integer_to_list(erlang:unique_integer([positive]))
    ).

expand_path(undefined) ->
    spawnd_config:home_dir();
expand_path(null) ->
    spawnd_config:home_dir();
expand_path(Bin) when is_binary(Bin) ->
    expand_path(binary_to_list(Bin));
expand_path("") ->
    spawnd_config:home_dir();
expand_path("~") ->
    spawnd_config:home_dir();
expand_path([$~, $/ | Rest]) ->
    filename:join(spawnd_config:home_dir(), Rest);
expand_path(Path) ->
    case filename:pathtype(Path) of
        absolute -> filename:absname(Path);
        _ -> filename:absname(filename:join(spawnd_config:home_dir(), Path))
    end.

safe_name(Bin) when is_binary(Bin) ->
    safe_name(binary_to_list(Bin));
safe_name(Name) ->
    Clean = [C || C <- filename:basename(Name), C =/= $/, C =/= 0],
    list_to_binary(case Clean of [] -> "upload"; _ -> Clean end).

write_unique(Base, Name, Bytes) ->
    {Root, Ext} = split_extension(Name),
    write_unique(Base, Root, Ext, Bytes, 0).

write_unique(Base, Root, Ext, Bytes, Attempt) ->
    Name =
        case Attempt of
            0 -> Root ++ Ext;
            _ -> Root ++ "-" ++ integer_to_list(Attempt + 1) ++ Ext
        end,
    Path = filename:join(Base, Name),
    case file:write_file(Path, Bytes, [write, binary, exclusive]) of
        ok -> {ok, Path};
        {error, eexist} -> write_unique(Base, Root, Ext, Bytes, Attempt + 1);
        Error -> Error
    end.

split_extension(Name) ->
    Ext = filename:extension(Name),
    RootLen = length(Name) - length(Ext),
    Root0 = lists:sublist(Name, RootLen),
    Root = case Root0 of [] -> "upload"; _ -> Root0 end,
    {Root, Ext}.

shell_quote(Bin) when is_binary(Bin) ->
    shell_quote(binary_to_list(Bin));
shell_quote(Str) ->
    "'" ++ string:replace(Str, "'", "'\\''", all) ++ "'".

to_list(Bin) when is_binary(Bin) ->
    binary_to_list(Bin);
to_list(List) when is_list(List) ->
    List.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

fs_list_returns_sorted_directory_entries_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-fs-list-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    ok = filelib:ensure_dir(filename:join(Base, "x")),
    ok = file:make_dir(filename:join(Base, "zeta")),
    ok = file:make_dir(filename:join(Base, "alpha")),
    ok = file:write_file(filename:join(Base, "note.txt"), <<"not a directory">>),
    Result = fs_list(list_to_binary(Base)),
    ?assertEqual(list_to_binary(filename:absname(Base)), maps:get(<<"path">>, Result)),
    ?assertEqual(null, maps:get(<<"error">>, Result)),
    Entries = maps:get(<<"entries">>, Result),
    ?assertEqual(
        [
            #{
                <<"name">> => <<"alpha">>,
                <<"path">> => list_to_binary(filename:join(filename:absname(Base), "alpha"))
            },
            #{
                <<"name">> => <<"zeta">>,
                <<"path">> => list_to_binary(filename:join(filename:absname(Base), "zeta"))
            }
        ],
        Entries
    ),
    _ = file:del_dir_r(Base),
    ok.

fs_list_reports_nonexistent_path_error_test() ->
    Path = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-missing-dir-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    Result = fs_list(list_to_binary(Path)),
    ?assertEqual([], maps:get(<<"entries">>, Result)),
    ?assertNotEqual(null, maps:get(<<"error">>, Result)).

save_upload_uses_non_overwriting_paths_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-upload-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    Obj = #{
        <<"cwd">> => list_to_binary(Base),
        <<"name">> => <<"note.txt">>,
        <<"destination">> => <<"cwd">>,
        <<"bytes_b64">> => base64:encode(<<"one">>)
    },
    Path1 = save_upload(Obj),
    Path2 = save_upload(Obj#{<<"bytes_b64">> => base64:encode(<<"two">>)}),
    ?assertNotEqual(Path1, Path2),
    ?assertEqual(<<"one">>, read_file(Path1)),
    ?assertEqual(<<"two">>, read_file(Path2)),
    _ = file:del_dir_r(Base),
    ok.

save_upload_sanitizes_names_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-upload-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    Path = save_upload(#{
        <<"cwd">> => list_to_binary(Base),
        <<"name">> => <<"../unsafe.txt">>,
        <<"destination">> => <<"cwd">>,
        <<"bytes_b64">> => base64:encode(<<"ok">>)
    }),
    ?assertEqual(list_to_binary(filename:join(Base, "unsafe.txt")), Path),
    ?assertEqual(<<"ok">>, read_file(Path)),
    _ = file:del_dir_r(Base),
    ok.

shell_capture_parses_success_exit_code_test() ->
    Result = shell_capture(<<"printf hi">>, 1000),
    ?assertMatch(#{<<"success">> := true, <<"exit_code">> := 0}, Result),
    ?assertEqual(<<"hi">>, maps:get(<<"output">>, Result)).

shell_capture_parses_failure_exit_code_test() ->
    Result = shell_capture(<<"false">>, 1000),
    ?assertMatch(#{<<"success">> := false, <<"exit_code">> := 1}, Result).

shell_capture_enforces_timeout_test() ->
    Started = erlang:monotonic_time(millisecond),
    Result = shell_capture(<<"printf before; sleep 5; printf after">>, 100),
    Elapsed = erlang:monotonic_time(millisecond) - Started,
    ?assertMatch(
        #{
            <<"success">> := false,
            <<"exit_code">> := null,
            <<"error">> := <<"install timed out">>
        },
        Result
    ),
    ?assert(Elapsed < 3000).

missing_tool_status_does_not_report_shell_error_as_version_test() ->
    Missing = <<
        "spawnd-definitely-missing-command-",
        (integer_to_binary(erlang:unique_integer([positive])))/binary
    >>,
    [Status] = tools_check([
        #{
            <<"preset_id">> => <<"missing">>,
            <<"preset_name">> => <<"missing">>,
            <<"agent_kind">> => <<"shell">>,
            <<"command">> => Missing
        }
    ]),
    ?assertEqual(false, maps:get(<<"installed">>, Status)),
    ?assertEqual(null, maps:get(<<"path">>, Status)),
    ?assertEqual(null, maps:get(<<"version">>, Status)).

tool_version_probe_times_out_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-tool-version-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    ok = filelib:ensure_dir(filename:join(Base, "x")),
    Command = "spawnd-slow-version",
    Script = filename:join(Base, Command),
    ok = file:write_file(Script, <<"#!/bin/sh\nsleep 5\nprintf late\n">>),
    ok = file:change_mode(Script, 8#755),
    OldPath = os:getenv("PATH"),
    os:putenv("PATH", Base ++ ":" ++ path_or_empty(OldPath)),
    Started = erlang:monotonic_time(millisecond),
    try
        [Status] = tools_check([
            #{
                <<"preset_id">> => <<"slow">>,
                <<"preset_name">> => <<"slow">>,
                <<"agent_kind">> => <<"shell">>,
                <<"command">> => list_to_binary(Command)
            }
        ]),
        Elapsed = erlang:monotonic_time(millisecond) - Started,
        ?assertEqual(true, maps:get(<<"installed">>, Status)),
        ?assertEqual(list_to_binary(Script), maps:get(<<"path">>, Status)),
        ?assertEqual(null, maps:get(<<"version">>, Status)),
        ?assert(Elapsed < 3500)
    after
        restore_path(OldPath),
        _ = file:del_dir_r(Base)
    end.

duplicate_tool_resolution_chooses_newest_version_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-tool-duplicates-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    OldDir = filename:join(Base, "old"),
    NewDir = filename:join(Base, "new"),
    Command = "spawnd-duplicate-tool",
    OldTool = filename:join(OldDir, Command),
    NewTool = filename:join(NewDir, Command),
    ok = fake_tool(OldTool, "codex-cli 0.36.0"),
    ok = fake_tool(NewTool, "codex-cli 0.133.0"),
    Env = [{"PATH", OldDir ++ ":" ++ NewDir}],
    ?assertEqual(OldTool, resolve_executable(Command, Env)),
    OldPath = os:getenv("PATH"),
    os:putenv("PATH", OldDir ++ ":" ++ NewDir ++ ":" ++ path_or_empty(OldPath)),
    try
        [Status] = tools_check([
            #{
                <<"preset_id">> => <<"codex">>,
                <<"preset_name">> => <<"codex">>,
                <<"agent_kind">> => <<"codex">>,
                <<"command">> => list_to_binary(Command)
            }
        ]),
        ?assertEqual(true, maps:get(<<"installed">>, Status)),
        ?assertEqual(list_to_binary(NewTool), maps:get(<<"path">>, Status)),
        ?assertEqual(<<"codex-cli 0.133.0">>, maps:get(<<"version">>, Status))
    after
        restore_path(OldPath),
        _ = file:del_dir_r(Base)
    end.

codex_npm_launcher_resolves_to_native_binary_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-codex-wrapper-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    BinDir = filename:join(Base, "bin"),
    PackageRoot = filename:join([Base, "lib", "node_modules", "@openai", "codex"]),
    Launcher = filename:join([PackageRoot, "bin", "codex.js"]),
    Native = filename:join([
        PackageRoot,
        "node_modules",
        "@openai",
        "codex-darwin-arm64",
        "vendor",
        "aarch64-apple-darwin",
        "bin",
        "codex"
    ]),
    Link = filename:join(BinDir, "codex"),
    ok = fake_tool(Launcher, "launcher 0.133.0"),
    ok = fake_tool(Native, "codex-cli 0.133.0"),
    ok = filelib:ensure_dir(Link),
    ok = file:make_symlink("../lib/node_modules/@openai/codex/bin/codex.js", Link),
    try
        ?assertEqual(Native, resolve_executable("codex", [{"PATH", BinDir}])),
        ?assertEqual(<<"codex-cli 0.133.0">>, version(resolve_executable("codex", [{"PATH", BinDir}])))
    after
        _ = file:del_dir_r(Base)
    end.

fake_tool(Path, Version) ->
    ok = filelib:ensure_dir(Path),
    ok = file:write_file(Path, list_to_binary(["#!/bin/sh\nprintf '", Version, "\\n'\n"])),
    file:change_mode(Path, 8#755).

path_or_empty(false) ->
    "";
path_or_empty(Path) ->
    Path.

restore_path(false) ->
    os:unsetenv("PATH");
restore_path(Path) ->
    os:putenv("PATH", Path).

read_file(Path) when is_binary(Path) ->
    {ok, Bytes} = file:read_file(binary_to_list(Path)),
    Bytes.
-endif.
