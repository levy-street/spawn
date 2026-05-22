-module(spawnd_host).

-export([fs_list/1, tools_check/1, tool_install/1, save_upload/1, expand_path/1]).

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
    Capture = shell_capture(Install, 180000),
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
    Path = filename:join(Base, binary_to_list(Name)),
    Bytes = base64:decode(maps:get(<<"bytes_b64">>, Obj)),
    ok = file:write_file(Path, Bytes),
    list_to_binary(Path).

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
    #{
        <<"preset_id">> => maps:get(<<"preset_id">>, Target, <<>>),
        <<"preset_name">> => maps:get(<<"preset_name">>, Target, <<>>),
        <<"agent_kind">> => maps:get(<<"agent_kind">>, Target, <<>>),
        <<"command">> => Command,
        <<"install">> => maps:get(<<"install">>, Target, null),
        <<"installed">> => Path =/= null,
        <<"path">> => Path,
        <<"version">> => version(Command),
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
    case string:trim(os:cmd(Cmd)) of
        [] -> null;
        Line -> list_to_binary(Line)
    end.

shell_capture(Install, _Timeout) when Install =:= <<>>; Install =:= null ->
    #{<<"success">> => false, <<"exit_code">> => null, <<"output">> => <<>>, <<"error">> => <<"preset has no install command">>};
shell_capture(Install, _Timeout) ->
    Cmd = binary_to_list(Install) ++ " 2>&1; printf '\\n__spawn_exit__$?'",
    Output = os:cmd(Cmd),
    {Text, Code} = split_exit(Output),
    #{<<"success">> => Code =:= 0, <<"exit_code">> => Code, <<"output">> => list_to_binary(Text), <<"error">> => null}.

split_exit(Output) ->
    Marker = "__spawn_exit__",
    case string:split(Output, Marker, trailing) of
        [Text, Code0] ->
            {Text, list_to_integer(string:trim(Code0))};
        _ ->
            {Output, null}
    end.

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

shell_quote(Bin) when is_binary(Bin) ->
    shell_quote(binary_to_list(Bin));
shell_quote(Str) ->
    "'" ++ string:replace(Str, "'", "'\\''", all) ++ "'".
