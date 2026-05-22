-module(spawnd_config).

-export([
    default_server/0,
    server_url/1,
    ws_url/1,
    api_url/2,
    config_dir/0,
    credentials_path/0,
    control_path/0,
    home_dir/0
]).

default_server() ->
    <<"http://localhost:8000">>.

server_url(undefined) ->
    case os:getenv("SPAWN_SERVER_URL") of
        false -> default_server();
        Env -> trim_trailing_slash(list_to_binary(Env))
    end;
server_url(Server) when is_list(Server) ->
    server_url(list_to_binary(Server));
server_url(Server) when is_binary(Server) ->
    trim_trailing_slash(Server).

ws_url(Server0) ->
    Server = server_url(Server0),
    Scheme =
        case binary:split(Server, <<"://">>) of
            [<<"https">>, Rest] -> <<"wss://", Rest/binary>>;
            [<<"http">>, Rest] -> <<"ws://", Rest/binary>>
        end,
    <<Scheme/binary, "/ws/daemon">>.

api_url(Server0, Path0) ->
    Server = server_url(Server0),
    Path = iolist_to_binary(Path0),
    <<Server/binary, Path/binary>>.

config_dir() ->
    Base =
        case os:getenv("XDG_CONFIG_HOME") of
            false -> filename:join(home_dir(), ".config");
            ConfigHome -> ConfigHome
        end,
    Dir = filename:join(Base, "spawn"),
    ok = filelib:ensure_dir(filename:join(Dir, "x")),
    Dir.

credentials_path() ->
    filename:join(config_dir(), "credentials.json").

control_path() ->
    filename:join(config_dir(), "control.sock").

home_dir() ->
    case os:getenv("HOME") of
        false -> ".";
        Home -> Home
    end.

trim_trailing_slash(<<>>) ->
    <<>>;
trim_trailing_slash(Bin) ->
    Size = byte_size(Bin),
    case binary:at(Bin, Size - 1) of
        $/ -> binary:part(Bin, 0, Size - 1);
        _ -> Bin
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

ws_url_rewrites_scheme_test() ->
    ?assertEqual(<<"wss://spawnd.dev/ws/daemon">>, ws_url(<<"https://spawnd.dev/">>)),
    ?assertEqual(<<"ws://localhost:8000/ws/daemon">>, ws_url(<<"http://localhost:8000">>)).
-endif.
