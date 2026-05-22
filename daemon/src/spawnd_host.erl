-module(spawnd_host).

-export([fs_list/1, tools_check/1, tool_install/1, save_upload/1, expand_path/1]).

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
    Path = which(Command),
    Version =
        case Path of
            null -> null;
            _ -> version(Command)
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

which(<<>>) ->
    null;
which(Command) ->
    Cmd = "command -v " ++ shell_quote(Command),
    case string:trim(os:cmd(Cmd)) of
        [] -> null;
        Path -> list_to_binary(Path)
    end.

version(<<>>) ->
    null;
version(Command) ->
    Cmd = shell_quote(Command) ++ " --version 2>&1 | sed -n '1p'",
    Capture = shell_capture(Cmd, ?VERSION_TIMEOUT_MS),
    case string:trim(maps:get(<<"output">>, Capture, <<>>)) of
        <<>> -> null;
        Line -> Line
    end.

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
