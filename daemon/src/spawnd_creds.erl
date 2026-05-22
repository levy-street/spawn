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
    Server = spawnd_config:server_url(ServerOpt),
    Configured = maps:get(<<"server_url">>, Creds, <<"(none)">>),
    HostId = maps:get(<<"host_id">>, Creds, <<"(none)">>),
    LoggedIn =
        case maps:get(<<"access_token">>, Creds, <<>>) of
            <<>> -> <<"no">>;
            _ -> <<"yes">>
        end,
    io:format("server:     ~s~n", [Server]),
    io:format("configured: ~s~n", [Configured]),
    io:format("logged in:  ~s~n", [LoggedIn]),
    io:format("host_id:    ~s~n", [HostId]),
    ok.
