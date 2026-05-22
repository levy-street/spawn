-module(spawnd_login).

-export([run/2]).

run(ServerOpt, HostNameOpt) ->
    ok = ensure_http(),
    Server = spawnd_config:server_url(ServerOpt),
    HostName = host_name(HostNameOpt),
    Body = #{
        <<"host_name">> => HostName,
        <<"os">> => os_name(),
        <<"arch">> => list_to_binary(erlang:system_info(system_architecture)),
        <<"version">> => <<"0.2.0">>
    },
    case post_json(spawnd_config:api_url(Server, "/api/auth/device/start"), Body, []) of
        {ok, Start} ->
            case decode_start(Start) of
                {ok, UserCode, Verification, DeviceCode, Interval} ->
                    io:format("spawn: open ~s and enter code ~s~n", [Verification, UserCode]),
                    poll(Server, DeviceCode, Interval);
                Error ->
                    Error
            end;
        Error ->
            Error
    end.

poll(Server, DeviceCode, Interval) ->
    timer:sleep(Interval * 1000),
    case post_json(spawnd_config:api_url(Server, "/api/auth/device/poll"), #{<<"device_code">> => DeviceCode}, []) of
        {ok, #{<<"access_token">> := Token, <<"host_id">> := HostId}} ->
            Creds = #{<<"access_token">> => Token, <<"host_id">> => HostId, <<"server_url">> => Server},
            ok = spawnd_creds:save(Creds),
            io:format("spawn: login complete; host_id ~s~n", [HostId]),
            ok;
        {ok, #{<<"error">> := <<"authorization_pending">>}} ->
            poll(Server, DeviceCode, Interval);
        {ok, #{<<"error">> := <<"slow_down">>}} ->
            poll(Server, DeviceCode, Interval + 2);
        {ok, #{<<"error">> := Error}} ->
            {error, Error};
        Other ->
            Other
    end.

post_json(Url, Body, Headers) ->
    Json = iolist_to_binary(spawnd_json:encode(Body)),
    Request = {binary_to_list(Url), [{"content-type", "application/json"} | Headers], "application/json", Json},
    case httpc:request(post, Request, [{timeout, 15000}], [{body_format, binary}]) of
        {ok, {{_, Status, _}, _RespHeaders, RespBody}} when Status >= 200, Status < 300 ->
            spawnd_json:decode(RespBody);
        {ok, {{_, Status, _}, _RespHeaders, RespBody}} ->
            {error, {http_status, Status, RespBody}};
        Error ->
            Error
    end.

ensure_http() ->
    application:ensure_all_started(inets),
    application:ensure_all_started(ssl),
    ok.

host_name(undefined) ->
    case inet:gethostname() of
        {ok, Name} -> list_to_binary(Name);
        _ -> <<"unknown-host">>
    end;
host_name(Name) when is_list(Name) ->
    list_to_binary(Name);
host_name(Name) ->
    Name.

os_name() ->
    {Family, Name} = os:type(),
    list_to_binary(io_lib:format("~p/~p", [Family, Name])).

decode_start(#{
    <<"user_code">> := UserCode,
    <<"verification_uri">> := Verification,
    <<"device_code">> := DeviceCode,
    <<"interval">> := Interval
}) ->
    {ok, UserCode, Verification, DeviceCode, Interval};
decode_start(#{
    <<"user_code">> := UserCode,
    <<"verification_uri">> := Verification,
    <<"device_code">> := DeviceCode
}) ->
    {ok, UserCode, Verification, DeviceCode, 5};
decode_start(_) ->
    {error, invalid_device_start_response}.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

decode_start_defaults_interval_test() ->
    ?assertEqual(
        {ok, <<"ABCD-EFGH">>, <<"http://localhost/device">>, <<"device-token">>, 5},
        decode_start(#{
            <<"user_code">> => <<"ABCD-EFGH">>,
            <<"verification_uri">> => <<"http://localhost/device">>,
            <<"device_code">> => <<"device-token">>
        })
    ).

decode_start_uses_server_interval_test() ->
    ?assertEqual(
        {ok, <<"ABCD-EFGH">>, <<"http://localhost/device">>, <<"device-token">>, 7},
        decode_start(#{
            <<"user_code">> => <<"ABCD-EFGH">>,
            <<"verification_uri">> => <<"http://localhost/device">>,
            <<"device_code">> => <<"device-token">>,
            <<"interval">> => 7
        })
    ).

decode_start_rejects_malformed_response_test() ->
    ?assertEqual({error, invalid_device_start_response}, decode_start(#{})).
-endif.
