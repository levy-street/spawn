-module(spawnd_creds).

-export([load/0, save/1, logout/0, status/1]).

load() ->
    Path = spawnd_config:credentials_path(),
    case file:read_file(Path) of
        {ok, Bin} ->
            case spawnd_json:decode(Bin) of
                {ok, Map} -> Map;
                _ -> #{}
            end;
        {error, enoent} ->
            #{};
        {error, _} ->
            #{}
    end.

save(Creds) ->
    Path = spawnd_config:credentials_path(),
    ok = filelib:ensure_dir(Path),
    Tmp = Path ++ "." ++ integer_to_list(erlang:unique_integer([positive])) ++ ".tmp",
    Bin = iolist_to_binary(spawnd_json:encode(Creds)),
    ok = file:write_file(Tmp, Bin, [write]),
    _ = file:change_mode(Tmp, 8#600),
    file:rename(Tmp, Path).

logout() ->
    Path = spawnd_config:credentials_path(),
    _ = file:delete(Path),
    io:format("spawn: removed ~s~n", [Path]),
    ok.

status(ServerOpt) ->
    Creds = load(),
    Configured = maps:get(<<"server_url">>, Creds, <<"(none)">>),
    Server = effective_server(ServerOpt, Configured),
    HostId = maps:get(<<"host_id">>, Creds, <<"(none)">>),
    LoggedIn =
        case maps:get(<<"access_token">>, Creds, <<>>) of
            <<>> -> <<"no">>;
            _ -> <<"yes">>
        end,
    io:put_chars(
        io_lib:format(
            "server:     ~s~nconfigured: ~s~nlogged in:  ~s~nhost_id:    ~s~n",
            [Server, Configured, LoggedIn, HostId]
        )
    ),
    ok.

effective_server(ServerOpt, _Configured) when ServerOpt =/= undefined ->
    spawnd_config:server_url(ServerOpt);
effective_server(undefined, Configured) ->
    case os:getenv("SPAWN_SERVER_URL") of
        false ->
            case Configured of
                <<"(none)">> -> spawnd_config:server_url(undefined);
                <<>> -> spawnd_config:server_url(undefined);
                _ -> spawnd_config:server_url(Configured)
            end;
        Env ->
            spawnd_config:server_url(Env)
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

effective_server_uses_configured_server_without_override_test() ->
    with_env_unset(
        "SPAWN_SERVER_URL",
        fun() ->
            ?assertEqual(
                <<"http://localhost:3002">>,
                effective_server(undefined, <<"http://localhost:3002/">>)
            )
        end
    ).

effective_server_prefers_cli_override_test() ->
    with_env(
        "SPAWN_SERVER_URL",
        "http://env.example",
        fun() ->
            ?assertEqual(
                <<"https://cli.example">>,
                effective_server(<<"https://cli.example/">>, <<"http://configured.example">>)
            )
        end
    ).

effective_server_prefers_env_over_configured_server_test() ->
    with_env(
        "SPAWN_SERVER_URL",
        "http://env.example/",
        fun() ->
            ?assertEqual(
                <<"http://env.example">>,
                effective_server(undefined, <<"http://configured.example">>)
            )
        end
    ).

with_env(Name, Value, Fun) ->
    Previous = os:getenv(Name),
    os:putenv(Name, Value),
    try Fun()
    after restore_env(Name, Previous)
    end.

with_env_unset(Name, Fun) ->
    Previous = os:getenv(Name),
    os:unsetenv(Name),
    try Fun()
    after restore_env(Name, Previous)
    end.

restore_env(Name, false) ->
    os:unsetenv(Name);
restore_env(Name, Value) ->
    os:putenv(Name, Value).
-endif.
